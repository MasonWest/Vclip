export interface Clip {
  id: number;
  content: string;
  created_at: string;
  expires_at: string;
  type?: 'text' | 'image';
  thumb?: string | null;
  status?: 'pending' | 'done';
  prompt?: string;
  prompt_version?: number;
  localUrl?: string;
  pending?: boolean;
  uid?: string;
}

export interface PromptValue { prompt: string; prompt_version: number }
export type PromptSaveResult = { ok: true; value: PromptValue } | { ok: false; error: string; latest?: PromptValue };
