// Shim for Cline's components/ui/button: the vendored CodeAccordian only needs a plain button with a "text" variant.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ variant: _variant, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; children?: ReactNode }) {
  return (
    <button type="button" className={`cline-button-text ${className ?? ""}`} {...rest}>
      {children}
    </button>
  );
}
