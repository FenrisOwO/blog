// The limiter every filesystem walk in this project runs through.
//
// It exists because the site's mount charges ~5-16ms per file operation: running those in
// parallel is the difference between a 300ms listing and a 50ms one, and running them
// *unbounded* is how a recursive walk runs out of file handles.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLimiter, inPool } from '../src/util/pool.js';

test('a limiter never runs more work at once than it is allowed', async () => {
  const limiter = createLimiter(3);
  let active = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 20 }, () =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
      }),
    ),
  );

  assert.equal(peak, 3, 'the bound is what keeps a walk from exhausting handles');
  assert.equal(active, 0, 'every slot is released');
});

test('inPool keeps results in input order', async () => {
  const results = await inPool([5, 1, 3, 2, 4], 2, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, item));
    return item * 10;
  });

  assert.deepEqual(results, [50, 10, 30, 20, 40]);
});

test('a rejecting task rejects the caller and does not wedge the pool', async () => {
  await assert.rejects(
    () =>
      inPool([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    /boom/,
  );

  const after = await inPool([1, 2, 3], 2, async (item) => item);
  assert.deepEqual(after, [1, 2, 3], 'the limiter is still usable');
});

test('an empty list is a no-op and a limit below one is clamped', async () => {
  assert.deepEqual(await inPool([], 4, async (item) => item), []);

  const limiter = createLimiter(0);
  assert.equal(await limiter.run(async () => 'ran'), 'ran');
});
