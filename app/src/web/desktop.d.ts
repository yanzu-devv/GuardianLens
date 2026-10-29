export {};
declare global {
  interface Window {
    guardianDesktop?: {
      openDashboard: () => void;
      openQuickAccess: () => void;
      setCameraEnabled: (enabled: boolean) => void;
      onCameraControl: (handler: (enabled: boolean) => void) => () => void;
      onInterruption: (handler: (reason: string) => void) => () => void;
    };
  }
}
