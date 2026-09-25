// Control: imported by the same island as hooks.ts, but doesn't import `astro:actions`.
// It's evaluated once, while hooks.ts is re-evaluated on every request.
console.log('DEBUG-REPRO eval plain.ts');

export const plain = 'plain';
