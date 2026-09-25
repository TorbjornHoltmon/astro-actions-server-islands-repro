import { defineAction } from 'astro:actions';

export const server = {
  a: {
    get: defineAction({
      handler: async () => 'a',
    }),
  },
};
