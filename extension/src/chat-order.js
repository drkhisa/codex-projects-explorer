'use strict';
const { threadKey } = require('./sections');
function reconcileOrder(saved, threads) {
  const previous = Array.isArray(saved) ? [...new Set(saved)] : [];
  const known = new Set(previous);
  const fresh = threads.filter(t => !known.has(threadKey(t))).sort((a,b) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0)).map(threadKey);
  // Keep hidden/archived entries so their place survives toggling archive or sections.
  return [...fresh, ...previous];
}
function orderedThreads(order, threads) {
  const rank = new Map(order.map((id,index) => [id,index]));
  return [...threads].sort((a,b) => (rank.get(threadKey(a)) ?? Infinity) - (rank.get(threadKey(b)) ?? Infinity));
}
function moveBefore(order, id, target = null) {
  const result = order.filter(key => key !== id), index = target ? result.indexOf(target) : 0;
  result.splice(index < 0 ? result.length : index,0,id); return result;
}
module.exports = { reconcileOrder, orderedThreads, moveBefore };
