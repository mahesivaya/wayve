/**
 * Branded (nominal) types over structural primitives.
 *
 * TypeScript is structural: `type UserId = number` and `type ChannelId = number`
 * are interchangeable, so a function `f(channelId: ChannelId, userId: UserId)`
 * happily accepts the two `number`s in the wrong order. The `Brand<T, B>`
 * helper attaches a phantom marker to refuse such cross-brand substitution at
 * compile time. The marker has no runtime presence — branded values are still
 * plain `number`s.
 *
 * Used **locally** — at one specific function boundary where two IDs of
 * different kinds are taken positionally and a swap would be a real bug.
 * NOT applied codebase-wide; most IDs travel inside named struct fields
 * (`{ user_id, account_id }`) where the field name already prevents mixing.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<number, "UserId">;
export type ChannelId = Brand<number, "ChannelId">;

/**
 * Tagged cast constructor for a `UserId`. Concentrates the unsafe cast at one
 * named call so a `grep asUserId` shows every boundary where a plain `number`
 * enters the branded world.
 */
export const asUserId = (n: number): UserId => n as UserId;

/** Same role as {@link asUserId} for channel ids. */
export const asChannelId = (n: number): ChannelId => n as ChannelId;
