export type AlertChannel = "sms" | "email";
export type AlertStatus = "draft" | "ready" | "cancelled";
export type AlertContentSource = "template" | "adhoc";

export interface IncidentSummaryRef {
  id: string;
  incidentNumber: string;
  title: string;
  status: string;
}

export interface TemplateSummaryRef {
  id: string;
  name: string;
  status: string;
}

export interface AlertSummary {
  id: string;
  alertNumber: string;
  title: string;
  incident: IncidentSummaryRef | null;
  channel: AlertChannel;
  status: AlertStatus;
  contentSource: AlertContentSource;
  eligibleRecipientCount: number | null;
  excludedCount: number | null;
  createdByDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  cancelledAt: string | null;
}

export interface SourceContactRef {
  id: string;
  displayName: string;
}

export interface SourceGroupRef {
  id: string;
  name: string;
}

export interface AlertDetail extends AlertSummary {
  template: TemplateSummaryRef | null;
  templateNameSnapshot: string | null;
  subject: string | null;
  body: string | null;
  exclusionSummary: Record<string, number> | null;
  sourceContactCount: number;
  sourceGroupCount: number;
  sourceContacts: SourceContactRef[];
  sourceGroups: SourceGroupRef[];
}

export interface AlertsListResponse {
  items: AlertSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AlertPreview {
  channel: AlertChannel;
  uniqueRecipientCount: number;
  eligibleCount: number;
  excludedCount: number;
  exclusionSummary: Record<string, number>;
  duplicatesCollapsedCount: number;
  invalidGroupIds: string[];
  zeroRecipientWarning: boolean;
  templateActive: boolean | null;
  sampleRenderedSubject?: string;
  sampleRenderedBody: string;
  sms?: { encoding: "GSM-7" | "UCS-2"; characterCount: number; gsmUnitCount: number | null; segmentCount: number };
}

export interface AlertRecipient {
  id: string;
  contactId: string | null;
  displayName: string | null;
  destination: string | null;
  channel: AlertChannel;
  renderedSubject: string | null;
  renderedBody: string | null;
  status: string;
  createdAt: string;
}

export interface AlertRecipientsListResponse {
  items: AlertRecipient[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
