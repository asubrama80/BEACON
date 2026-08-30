export interface AlertConfig {
  /** Safety cap on eligible recipients for a single Alert — see module doc, "Mass-audience safety". */
  maxRecipients: number;
}

export function loadAlertConfig(source: NodeJS.ProcessEnv = process.env): AlertConfig {
  return {
    maxRecipients: Number(source.ALERT_MAX_RECIPIENTS ?? 5000),
  };
}
