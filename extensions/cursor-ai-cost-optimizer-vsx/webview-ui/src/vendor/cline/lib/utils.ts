// Vendored from Cline (apps/vscode/webview-ui/src/...), Apache-2.0, see the LICENSE beside this vendor directory. Unmodified.
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}
