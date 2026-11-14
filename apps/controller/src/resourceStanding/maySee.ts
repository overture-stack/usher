import type { Onlooker, ResourceStanding } from './types.js';

/**
 * Whether a principal may see a resource. A retired resource is seen only by a platform
 * administrator asking for it. Any other is seen by a platform administrator, by a holder of a live
 * grant on it that their latest answer did not reject, its owners among them, and, while it is not
 * suppressed, by every signed-in principal when its access level is `open` or `registered`. Nobody
 * else sees it.
 *
 * @param standing where the principal stands on the resource.
 * @param onlooker whether the principal is a platform administrator, and asks for a retired
 *   resource.
 */
export const maySee = (
  { accessLevel, holder, retired, suppressed }: ResourceStanding,
  { administrator, asksForRetired }: Onlooker,
): boolean => {
  if (retired) {
    return administrator && asksForRetired;
  }
  return (
    administrator ||
    holder ||
    (!suppressed && (accessLevel === 'open' || accessLevel === 'registered'))
  );
};
