export interface GitIdentity {
  name: string;
  email: string;
}

export type GitIdentityMap = Record<string, GitIdentity>;

export class GitIdentityResolver {
  constructor(private readonly identities: GitIdentityMap = {}) {}

  resolve(userId: string): GitIdentity {
    const identity = this.identities[userId];
    if (!identity) throw new Error(`git_identity_required: no verified Git identity is configured for ${userId}`);
    if (!identity.name.trim() || !identity.email.trim()) throw new Error('git_identity_invalid: Git name and email are required');
    if (/^(?:ou_|on_|cli_)/i.test(identity.name.trim()) || /@link-bot\.local$/i.test(identity.email.trim())) {
      throw new Error('git_identity_invalid: internal platform identifiers cannot be used as Git identity');
    }
    return { name: identity.name.trim(), email: identity.email.trim() };
  }
}
