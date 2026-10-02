import { expect, it } from 'vitest';
import { recordSearchTiming, subscribeSearchTiming } from './workerTimings';
it('delivers only fixed metric names and finite durations during a subscription', () => {
  const samples: unknown[] = [];
  recordSearchTiming('searchIndex', 1);
  const stop = subscribeSearchTiming((...sample) => samples.push(sample));
  recordSearchTiming('searchIndex', 4);
  recordSearchTiming('searchQuery', NaN);
  recordSearchTiming('searchPrepare', -1);
  recordSearchTiming('private source' as 'searchIndex', 2);
  recordSearchTiming('__proto__' as 'searchIndex', 2);
  stop();
  recordSearchTiming('searchIndex', 3);
  expect(samples).toEqual([['search-index', 4]]);
});
