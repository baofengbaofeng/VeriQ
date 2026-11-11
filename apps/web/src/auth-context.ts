import { createContext } from "react";
import type { User } from "./api";
export type AuthState = {
  user: User | null;
  refresh: () => Promise<void>;
  setupComplete: () => void;
};
export const Auth = createContext<AuthState>({
  user: null,
  refresh: async () => {},
  setupComplete: () => {},
});
