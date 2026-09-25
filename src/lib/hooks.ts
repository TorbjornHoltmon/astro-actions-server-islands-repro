// Imports `astro:actions` and reads an action at module top level (a common pattern, e.g. building
// query hooks from actions). Every re-evaluation of this module is logged, so `count.sh` can show
// how often it runs. If it's evaluated against a partially-initialised Astro actions runtime, the
// top-level read throws `Cannot read properties of undefined (reading 'actionName' | 'a')`.
import { actions } from 'astro:actions';
console.log('DEBUG-REPRO eval hooks.ts, typeof actions =', typeof actions);

export const actionA = actions.a.get;
