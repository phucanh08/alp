import { placeOrder } from '../app/place-order.js';
export const postOrder = (body: { total: number }) => ({ status: 201, body: placeOrder(body.total) });
