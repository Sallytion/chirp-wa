import { decodeSyncdSnapshot, extractSyncdPatches } from '@whiskeysockets/baileys';
import type { ChatMutation, Contact, WASocket } from '@whiskeysockets/baileys';

export function contactsFromMutations(mutations: ChatMutation[]): Partial<Contact>[] {
  return mutations.flatMap((mutation) => {
    const action = mutation.syncAction.value?.contactAction;
    const id = mutation.index[1];
    if (!action || !id) return [];
    return [
      {
        id,
        name: action.fullName || action.firstName || action.username || undefined,
        lid: action.lidJid || undefined,
        phoneNumber: id.endsWith('@s.whatsapp.net') ? id : action.pnJid || undefined,
      },
    ];
  });
}

// Read a fresh contact snapshot without resetting Baileys' app-state version or
// writing mutations to WhatsApp. SDK decryption verifies the snapshot's MACs.
export async function fetchContactSnapshot(
  socket: WASocket,
): Promise<Partial<Contact>[] | undefined> {
  const collection = 'critical_unblock_low';
  const result = await socket.query(
    {
      tag: 'iq',
      attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'w:sync:app:state' },
      content: [
        {
          tag: 'sync',
          attrs: {},
          content: [
            {
              tag: 'collection',
              attrs: { name: collection, version: '0', return_snapshot: 'true' },
            },
          ],
        },
      ],
    },
    20_000,
  );
  const collections = await extractSyncdPatches(result, { signal: AbortSignal.timeout(20_000) });
  const snapshot = collections[collection]?.snapshot;
  if (!snapshot) return;
  const { mutationMap } = await decodeSyncdSnapshot(
    collection,
    snapshot,
    async (key) => (await socket.authState.keys.get('app-state-sync-key', [key]))[key],
    undefined,
    true,
  );
  return contactsFromMutations(Object.values(mutationMap));
}
