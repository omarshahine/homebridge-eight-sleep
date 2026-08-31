export type Side = 'left' | 'right' | 'solo';
export type SidePrefix = 'left' | 'right';
export type Mode = 'heat' | 'cool';

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  userId?: string;
}

export interface MeResponse {
  user: {
    userId: string;
    currentDevice?: {
      id?: string;
      side?: string;
    };
    devices?: string[];
  };
}

export interface UserResponse {
  user: {
    userId: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

export interface KelvinState {
  active?: boolean;
  currentTargetLevel?: number;
  level?: number;
}

export interface DeviceResult {
  online?: boolean;
  modelString?: string;
  firmwareVersion?: string;
  leftUserId?: string;
  rightUserId?: string;
  awaySides?: Record<string, string>;
  leftHeatingLevel?: number;
  leftTargetHeatingLevel?: number;
  leftNowHeating?: boolean;
  leftKelvin?: KelvinState;
  rightHeatingLevel?: number;
  rightTargetHeatingLevel?: number;
  rightNowHeating?: boolean;
  rightKelvin?: KelvinState;
}

export interface DeviceResponse {
  result: DeviceResult;
}

export interface SideState {
  on: boolean;
  targetLevel: number;
  currentLevel: number;
  nowHeating: boolean;
}

export interface EightSleepConfig {
  name?: string;
  email?: string;
  password?: string;
  pollInterval?: number;
  awaySwitch?: boolean;
  leftName?: string;
  rightName?: string;
  debug?: boolean;
}
