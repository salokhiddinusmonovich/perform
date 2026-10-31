import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Whether a row's text has what was typed in a search box, whatever the case. */
export function matchesSearch(text: string, query: string) {
  return text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
