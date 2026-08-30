export type TemplateChannel = "sms" | "email";

export interface Template {
  id: string;
  name: string;
  channel: TemplateChannel;
  subject: string | null;
  status: string;
  placeholders: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDetail extends Template {
  body: string;
}

export interface TemplatesListResponse {
  items: Template[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SmsSegmentEstimate {
  encoding: "GSM-7" | "UCS-2";
  characterCount: number;
  gsmUnitCount: number | null;
  segmentCount: number;
}

export interface PreviewResponse {
  channel: TemplateChannel;
  renderedSubject?: string;
  renderedBody: string;
  unresolvedPlaceholders: string[];
  sms?: SmsSegmentEstimate;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
