export interface AdminStatus {
  application: {
    name: string;
    version: string;
    environment: string;
  };
  database: {
    connected: boolean;
  };
  security: {
    mfaAvailable: true;
    sessionTtlHours: number;
    passwordMinLength: number;
    loginMaxFailures: number;
    breakGlass: {
      present: boolean;
      status: string | null;
    };
  };
  providers: {
    sms: string;
    email: string;
  };
  collaboration: {
    status: "foundation_only";
  };
}

export interface RoleSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissionCodes: string[];
  userCount: number;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
