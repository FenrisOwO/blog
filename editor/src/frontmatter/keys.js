// Front matter keys the P1 layer is allowed to manage. Anything else is "unknown" and
// must survive a save byte-for-byte.

export const MANAGED_KEYS = [
  'title',
  'date',
  'description',
  'slug',
  'draft',
  'tags',
  'categories',
];
