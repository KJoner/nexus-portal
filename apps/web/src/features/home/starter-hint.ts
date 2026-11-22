import { pinnedSites, STARTER_SITES, type Config } from '@nexus/shared';
import { useState } from 'react';
import { workspaceOwner } from '../../data/config-store';
import { useLibrary } from '../../data/library';
import { storage } from '../../lib/storage';

/**
 * 「已为你放好常用网站 · 调整」 (UI v2 · spec 01 §6, 07 §5): said once, in a space that was created with
 * the eight starter sites — known from the collection's starterVersion when it is loaded, otherwise
 * from the home page still showing exactly those eight pinned in their starter order. Dismissed per
 * collection in this browser. Never a reason to add, re-pin or bring back anything.
 */
const key = () => `nexus.hint.starter.v1:${workspaceOwner() ?? 'unknown'}`;

export function looksLikeStarterHome(c: Config): boolean {
  const pinned = pinnedSites(c);
  return pinned.length === STARTER_SITES.length && pinned.every((a, k) => a.catalogId === STARTER_SITES[k]!.catalogId);
}

export function useStarterHint(c: Config): { show: boolean; dismiss(): void } {
  const starter = useLibrary((s) => s.starterVersion);
  const [gone, setGone] = useState(() => storage.get<boolean>(key()) === true);
  const show = !gone && (starter === undefined ? looksLikeStarterHome(c) : starter === 1 && looksLikeStarterHome(c));
  return {
    show,
    dismiss() {
      storage.set(key(), true);
      setGone(true);
    },
  };
}
