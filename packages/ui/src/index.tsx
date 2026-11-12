import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
const button = cva("vq-button", {
  variants: {
    tone: {
      primary: "vq-primary",
      secondary: "vq-secondary",
      danger: "vq-danger",
    },
  },
  defaultVariants: { tone: "primary" },
});
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: "primary" | "secondary" | "danger";
  }
>(({ tone, className, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={button({ tone, className })}
    {...props}
  />
));
export function ConfirmDialog({
  title,
  children,
  trigger,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  trigger: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button tone="secondary">{trigger}</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="vq-overlay" />
        <Dialog.Content className="vq-dialog">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div>{children}</div>
          </Dialog.Description>
          <div className="vq-actions">
            <Dialog.Close asChild>
              <Button tone="secondary">取消 / Cancel</Button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <Button onClick={onConfirm}>确认 / Confirm</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="vq-section" data-testid={testId}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
