import { newOrder, type Order } from '../domain/order.js';
/* import { postOrder } from '../api/orders.js'; -- a comment, not an import */
export const placeOrder = (total: number): Order => newOrder(total);
