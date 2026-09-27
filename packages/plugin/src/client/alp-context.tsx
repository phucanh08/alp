import type { AlpApi } from "@alp/client";
import { createContext, useContext, type ReactNode } from "react";

const AlpApiContext = createContext<AlpApi | null>(null);

export function useAlpContextValue(): AlpApi | null {
  return useContext(AlpApiContext);
}

export function AlpApiProvider({ children, alp }: { children: ReactNode; alp: AlpApi }) {
  return <AlpApiContext.Provider value={alp}>{children}</AlpApiContext.Provider>;
}

export function useAlp(): AlpApi {
  const alp = useAlpContextValue();
  if (!alp) throw new Error("useAlp must run inside a contributed plugin surface");
  return alp;
}
