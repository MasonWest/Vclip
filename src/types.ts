export interface Clip {
  id: number;
  content: string;
  created_at: string;
  expires_at: string;
  type?: 'text' | 'image';
  thumb?: string | null;
  status?: 'pending' | 'done';
  comment_count?: number;
  localUrl?: string;
  pending?: boolean;
  uid?: string;
}

export interface Comment {
  id: number;
  clip_id: number;
  reply_to: number | null;
  author: string;
  content: string;
  created_at: string;
}
