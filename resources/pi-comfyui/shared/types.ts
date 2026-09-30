export interface Attachment {
  id: string;
  name: string;
  path: string;
  mimeType?: string;
  data?: string;
  maskFor?: string;
}
