import ts from 'typescript';

// Generated protobuf constructors eagerly allocate methods for hundreds of
// message variants. Preserve every variant, but materialize its constructor
// only when the SDK actually accesses it. This runs at build time only.
export function lazyProtobuf(source, filename, emitFactory) {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  // Extracted factories lose their module closure. Pass the SDK's shared
  // conversion helpers as well as protobuf globals, including any newly
  // generated top-level functions, without duplicating them in every file.
  const bindings = [
    '$root',
    '$Reader',
    '$Writer',
    '$util',
    '$protobuf',
    '__protoRequire',
    ...file.statements
      .filter(ts.isFunctionDeclaration)
      .flatMap((node) => (node.name ? [node.name.text] : [])),
  ];
  let transformed = 0;
  const result = ts.transform(file, [
    (context) => {
      const f = context.factory;
      const prop = (name, value) => f.createPropertyAssignment(name, value);
      const define = (owner, name, descriptor) =>
        f.createCallExpression(
          f.createPropertyAccessExpression(f.createIdentifier('Object'), 'defineProperty'),
          undefined,
          [owner, f.createStringLiteral(name), f.createObjectLiteralExpression(descriptor)],
        );
      const stored = () => [
        f.createShorthandPropertyAssignment('value'),
        prop('writable', f.createTrue()),
        prop('configurable', f.createTrue()),
        prop('enumerable', f.createTrue()),
      ];
      const visit = (node) => {
        const next = ts.visitEachChild(node, visit, context);
        if (
          !ts.isBinaryExpression(next) ||
          next.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
          !ts.isPropertyAccessExpression(next.left) ||
          !ts.isIdentifier(next.left.expression) ||
          next.left.expression.text === '$root' ||
          !ts.isCallExpression(next.right) ||
          next.right.arguments.length
        )
          return next;
        let callee = next.right.expression;
        while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
        if (!ts.isFunctionExpression(callee)) return next;
        const owner = next.left.expression;
        const name = next.left.name.text;
        transformed++;
        let factory = next.right;
        if (emitFactory) {
          const id = transformed;
          const body = ts.createPrinter().printNode(ts.EmitHint.Expression, next.right, file);
          const parameters = [...bindings, owner.text];
          emitFactory(
            `type-${id}.cjs`,
            `module.exports = function(${parameters.join(',')}) { return ${body}; };`,
          );
          factory = f.createCallExpression(
            f.createCallExpression(f.createIdentifier('__protoRequire'), undefined, [
              f.createStringLiteral(`./type-${id}.cjs`),
            ]),
            undefined,
            parameters.map((name) => f.createIdentifier(name)),
          );
        }
        return define(owner, name, [
          prop('configurable', f.createTrue()),
          prop('enumerable', f.createTrue()),
          prop(
            'get',
            f.createFunctionExpression(
              undefined,
              undefined,
              undefined,
              undefined,
              [],
              undefined,
              f.createBlock(
                [
                  f.createVariableStatement(
                    undefined,
                    f.createVariableDeclarationList(
                      [f.createVariableDeclaration('value', undefined, undefined, factory)],
                      ts.NodeFlags.Const,
                    ),
                  ),
                  f.createExpressionStatement(define(owner, name, stored())),
                  f.createReturnStatement(f.createIdentifier('value')),
                ],
                true,
              ),
            ),
          ),
          prop(
            'set',
            f.createFunctionExpression(
              undefined,
              undefined,
              undefined,
              undefined,
              [f.createParameterDeclaration(undefined, undefined, 'value')],
              undefined,
              f.createBlock([f.createExpressionStatement(define(owner, name, stored()))], true),
            ),
          ),
        ]);
      };
      return (node) => ts.visitNode(node, visit);
    },
  ]);
  try {
    let output = ts.createPrinter().printFile(result.transformed[0]);
    if (emitFactory)
      output =
        `import { createRequire as __protocolRequire } from 'node:module';\nimport { dirname as __protocolDirname, basename as __protocolBasename } from 'node:path';\nimport { fileURLToPath as __protocolFile } from 'node:url';\nconst __protoRequire = __protocolRequire(new URL(__protocolBasename(__protocolDirname(__protocolFile(import.meta.url))) === 'chunks' ? '../protocol/entry.cjs' : './protocol/entry.cjs', import.meta.url));\n` +
        output;
    if (transformed < 100)
      throw new Error(`Unexpected protobuf layout: only ${transformed} constructors found`);
    return { code: output, transformed };
  } finally {
    result.dispose();
  }
}
