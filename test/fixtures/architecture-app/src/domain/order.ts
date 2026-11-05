import { id } from '../shared/id.js';
// An order's rules live here; no framework imports (see docs/architecture/boundaries.md).
export interface Order { id: string; total: number }
export const newOrder = (total: number): Order => ({ id: id(), total });
