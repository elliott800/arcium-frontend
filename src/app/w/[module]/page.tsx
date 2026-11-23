// Page: one dashboard of the workspace, /w/<dashboard id> (from src/modules/registry.ts).

import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { SESSION_COOKIE, userFromToken } from '@/lib/auth';
import { mayOpen, moduleById } from '@/modules/registry';
import Planned from '@/modules/planned';

type Props = { params: Promise<{ module: string }>; searchParams: Promise<Record<string, string | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const m = moduleById(decodeURIComponent((await params).module));
  return { title: m?.title ?? 'Not found' };
}

export default async function ModulePage({ params, searchParams }: Props) {
  const id = decodeURIComponent((await params).module);
  const m = moduleById(id);
  const user = await userFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!m || !user || !mayOpen(m, { role: user.role, portal: true })) notFound();
  if (!m.load) return <Planned def={m} />;
  const { default: Module } = await m.load();
  return <Module searchParams={searchParams} />;
}
