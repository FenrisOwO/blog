// Bounding how many filesystem operations are in flight at once.
//
// The site and the editor's build tree live on a mount where one file operation costs
// 5-16ms, so serial IO is the dominant cost of anything that touches more than a handful of
// files (measured: 474 sequential writes 7.8s, 474 parallel writes 2.0s). Parallelising
// without a bound is not an option either - a recursive walk can open thousands of handles -
// so every walker in this project runs through a limiter.

export function createLimiter(limit) {
  const width = Math.max(1, limit);
  const waiting = [];
  let active = 0;

  const pump = () => {
    while (active < width && waiting.length > 0) {
      const job = waiting.shift();
      active += 1;
      Promise.resolve()
        .then(job.work)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    run(work) {
      return new Promise((resolve, reject) => {
        waiting.push({ work, resolve, reject });
        pump();
      });
    },
    get active() {
      return active;
    },
  };
}

// Run `work` over every item, at most `concurrency` at a time. Results keep the input order,
// so a caller can compare against a sequential run.
export function inPool(items, concurrency, work) {
  const limiter = createLimiter(concurrency);
  return Promise.all(items.map((item, index) => limiter.run(() => work(item, index))));
}
