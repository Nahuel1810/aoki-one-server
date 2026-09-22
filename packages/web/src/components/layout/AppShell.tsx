import { BarChart3, LayoutGrid, Router as RouterIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'
import { ConnectionBanner } from './ConnectionBanner'
import { SystemStatus } from './SystemStatus'
import { cn } from '@/lib/cn'

const NAV = [
  { to: '/', label: 'Pickeo', icon: LayoutGrid, end: true },
  { to: '/dispositivos', label: 'Equipos', icon: RouterIcon, end: false },
  { to: '/metricas', label: 'Métricas', icon: BarChart3, end: false },
] as const

function NavItem({
  to,
  label,
  end,
  children,
}: {
  to: string
  label: string
  end: boolean
  children: ReactNode
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex h-12 items-center gap-2.5 rounded-control px-4 text-base font-semibold transition-colors',
          isActive
            ? 'bg-white text-brand-800 shadow-sm'
            : 'text-brand-100 hover:bg-white/10 hover:text-white',
        )
      }
    >
      {children}
      <span>{label}</span>
    </NavLink>
  )
}

/**
 * Nav plana de tres rutas, siempre visible. Sin jerarquia ni permisos (RF01).
 *
 * El header va oscuro y el contenido claro: separa de un vistazo el chrome de
 * la aplicacion de los datos de la operacion, que son lo que se mira todo el
 * dia. La barra va arriba y no al costado porque la tablet se usa en landscape
 * y el ancho es el recurso escaso.
 */
export function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 bg-brand-900 bg-gradient-to-r from-brand-950 via-brand-900 to-brand-800 shadow-raised">
        <div className="flex items-center gap-3 px-4 py-3 sm:gap-5 sm:px-6">
          <img
            src="/aoki-wordmark.png"
            alt="Aoki"
            className="logo-invert h-7 w-auto shrink-0 opacity-95"
            width={560}
            height={236}
          />

          <span aria-hidden className="hidden h-8 w-px bg-white/20 lg:block" />

          <nav aria-label="Secciones" className="flex items-center gap-1.5">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavItem key={to} to={to} label={label} end={end}>
                <Icon className="size-5 shrink-0" aria-hidden />
              </NavItem>
            ))}
          </nav>

          <div className="ml-auto">
            <SystemStatus />
          </div>
        </div>
        <ConnectionBanner />
      </header>

      <main className="flex min-h-0 flex-1 flex-col p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  )
}
