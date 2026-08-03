export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
}

export interface PreparedTerminalOptions<TOptions> {
  readonly options: TOptions;
  dispose(): void;
}

type Awaitable<T> = T | PromiseLike<T>;

export interface TerminalProfileControllerDependencies<TOptions, TProfile> {
  readonly selectProfileId: (token: CancellationTokenLike) => Awaitable<string | undefined>;
  readonly createTerminalOptions: (
    profileId: string,
    token: CancellationTokenLike
  ) => Awaitable<PreparedTerminalOptions<TOptions>>;
  readonly createTerminalProfile: (options: TOptions) => TProfile;
}

export class TerminalProfileController<TOptions, TProfile> {
  constructor(private readonly dependencies: TerminalProfileControllerDependencies<TOptions, TProfile>) {}

  async provideTerminalProfile(token: CancellationTokenLike): Promise<TProfile | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }

    const profileId = await this.dependencies.selectProfileId(token);
    if (profileId === undefined || token.isCancellationRequested) {
      return undefined;
    }

    const prepared = await this.dependencies.createTerminalOptions(profileId, token);
    if (token.isCancellationRequested) {
      prepared.dispose();
      return undefined;
    }

    let profile: TProfile;
    try {
      profile = this.dependencies.createTerminalProfile(prepared.options);
    } catch (error) {
      prepared.dispose();
      throw error;
    }

    if (token.isCancellationRequested) {
      prepared.dispose();
      return undefined;
    }

    return profile;
  }
}
