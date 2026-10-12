import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WASocket, ChatMutation } from '@whiskeysockets/baileys';
import { contactsFromMutations, fetchContactSnapshot } from '../src/contacts.js';

test('full contact snapshot requests do not reset or mutate the authentication key store', async () => {
  let requested: any;
  let keyWrites = 0;
  const socket = {
    query: async (node: unknown) => {
      requested = node;
      return {
        tag: 'iq',
        attrs: {},
        content: [
          {
            tag: 'sync',
            attrs: {},
            content: [
              {
                tag: 'collection',
                attrs: { name: 'critical_unblock_low', version: '7' },
                content: [],
              },
            ],
          },
        ],
      };
    },
    authState: {
      keys: {
        set: async () => {
          keyWrites++;
        },
      },
    },
  } as unknown as WASocket;
  assert.equal(await fetchContactSnapshot(socket), undefined);
  assert.deepEqual(requested.content[0].content[0].attrs, {
    name: 'critical_unblock_low',
    version: '0',
    return_snapshot: 'true',
  });
  assert.equal(keyWrites, 0);
});

test('contact snapshots preserve saved names and phone/LID mappings without applying unrelated mutations', () => {
  const mutations: ChatMutation[] = [
    {
      index: ['contact', '123@s.whatsapp.net'],
      syncAction: {
        value: { contactAction: { fullName: 'Saved name', firstName: 'First', lidJid: '999@lid' } },
      },
    },
    {
      index: ['contact', '888@lid'],
      syncAction: {
        value: { contactAction: { firstName: 'Fallback name', pnJid: '456@s.whatsapp.net' } },
      },
    },
    {
      index: ['contact', '777@lid'],
      syncAction: { value: { contactAction: { username: 'Username' } } },
    },
    {
      index: ['mute', '123@s.whatsapp.net'],
      syncAction: { value: { muteAction: { muted: true } } },
    },
  ];
  const contacts = contactsFromMutations(mutations);
  assert.equal(contacts.length, 3);
  assert.equal(contacts[0].name, 'Saved name');
  assert.equal(contacts[0].phoneNumber, '123@s.whatsapp.net');
  assert.equal(contacts[0].lid, '999@lid');
  assert.equal(contacts[1].phoneNumber, '456@s.whatsapp.net');
  assert.equal(contacts[1].name, 'Fallback name');
  assert.equal(contacts[2].name, 'Username');
});
