import { useViewport } from '../../lib/hooks';
import { DesktopHome } from './desktop/DesktopHome';
import { MobileHome } from './mobile/MobileHome';

/** Desktop layout needs room for the 760px search slab; anything smaller gets the mobile home. */
export function HomePage() {
  const { w, h } = useViewport();
  return w >= 900 && h >= 560 ? <DesktopHome /> : <MobileHome />;
}
