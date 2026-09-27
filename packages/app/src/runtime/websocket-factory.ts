import { nativeWebSocketFactory } from "@alp/client/internal/daemon-client-websocket-transport";
import type { WebSocketFactory } from "@alp/client/internal/daemon-client-transport-types";

export function createAppWebSocketFactory(): WebSocketFactory {
  return nativeWebSocketFactory;
}
