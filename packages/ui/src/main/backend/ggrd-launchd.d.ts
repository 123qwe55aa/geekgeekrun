declare module '@geekgeekrun/ggrd/lib/launchd.mjs' {
  export function installLaunchdSupervisor(options: {
    bootstrapSource: string
    bootstrapVersion: string
    httpsProxy?: string
    electronVersion?: string
  }): Promise<void>
}
