import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "./api";
export function Notice({
  error,
  message,
}: {
  error?: string;
  message?: string;
}) {
  return (
    <>
      {error && (
        <p role="alert" data-testid="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" data-testid="success">
          {message}
        </p>
      )}
    </>
  );
}
export function Field({
  name,
  label,
  type = "text",
  minLength,
}: {
  name: string;
  label: string;
  type?: string;
  minLength?: number;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        data-testid={name}
        type={type}
        required
        minLength={minLength}
        maxLength={type === "password" ? 1024 : type === "email" ? 254 : 160}
        autoComplete={
          type === "password"
            ? name === "password"
              ? "current-password"
              : "new-password"
            : name === "email"
              ? "username"
              : "off"
        }
      />
    </label>
  );
}
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  return {
    busy,
    error,
    message,
    setMessage,
    run: async (fn: () => Promise<void>) => {
      setBusy(true);
      setError("");
      setMessage("");
      try {
        await fn();
      } catch (e) {
        setError(
          e instanceof ApiError
            ? e.message
            : "Unable to reach VeriQ. Please try again.",
        );
      } finally {
        setBusy(false);
      }
    },
  };
}
export function values(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<
    string,
    string
  >;
}
export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <h1>{title}</h1>
      {children}
    </section>
  );
}
