import type { MessageKey } from "./catalogs/zh-CN.js";

type PluralBase<Key> = Key extends `${infer Base}.one` ? Base : never;
export type PluralMessageKey = PluralBase<MessageKey>;

/** Every base message is required; languages may add their own plural forms. */
export type MessageCatalog = Readonly<
  Record<MessageKey, string>
  & Partial<Record<`${PluralMessageKey}.${Intl.LDMLPluralRule}`, string>>
>;
