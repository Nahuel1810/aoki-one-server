import { expect, test, type Page } from '@playwright/test'
import { isApiRequest, mockApi } from './fixtures'

test.describe('Zona de pickeo', () => {
  test('el tablero muestra el cajon de cada slot y lo que esta en curso', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')

    // El dato mas grande de la pantalla es el cajon, no el slot.
    await expect(page.getByText('3X07AB2')).toBeVisible()
    await expect(page.getByText('Listo')).toBeVisible()

    // Un slot en maniobra dice de donde viene el cajon.
    await expect(page.getByText('3X09AD1').first()).toBeVisible()
    await expect(page.getByText('En camino')).toBeVisible()

    // El codigo del slot no se muestra: al operario solo le importa el cajon.
    await expect(page.getByText('3X01AA1')).toHaveCount(0)
  })

  test('tocar un cajon lo manda a guardar sin pasos intermedios', async ({ page }) => {
    const recorded = await mockApi(page)
    await page.goto('/')

    await page.getByRole('button', { name: /guardar 3X07AB2/i }).click()

    // Sin dialogo de por medio: el pedido sale y queda cancelable en la lista.
    await expect.poll(() => recorded.filter((c) => c.url === '/api/orders')).toHaveLength(1)
    // El destino viaja explicito: es la ubicacion de la que salio el cajon.
    expect(recorded.find((c) => c.url === '/api/orders')?.body).toEqual({
      type: 'PUT',
      origin: 'MANUAL',
      locationCode: '3X01AA1',
      targetLocation: '3X07AB2',
    })
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('un slot libre no se puede tocar', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')

    // Solo el slot ocupado es un boton: el resto no ofrece accion.
    await expect(page.getByRole('button', { name: /guardar 3X07AB2/i })).toHaveCount(1)
  })

  test('destrabar una orden en error', async ({ page }) => {
    const recorded = await mockApi(page)
    await page.goto('/')

    await expect(page.getByText('El carro no confirmo la maniobra')).toBeVisible()
    await page.getByRole('button', { name: 'Reintentar' }).click()

    await expect
      .poll(() => recorded.filter((c) => c.url === '/api/orders/o-error/retry'))
      .toHaveLength(1)
  })

  test('todo pedido se puede cancelar; reintentar solo el que fallo', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')

    // Dos pedidos en curso, los dos cancelables.
    await expect(page.getByRole('button', { name: 'Cancelar' })).toHaveCount(2)
    // Reintentar solo tiene sentido en el que fallo.
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(1)
  })

  test('el texto de las acciones entra en su boton', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await page.getByText('Pedidos en curso').waitFor()

    // "Cancelar" no entraba en el boton cuadrado de 48px y se salia del borde.
    for (const name of ['Cancelar', 'Reintentar']) {
      const boton = page.getByRole('button', { name }).first()
      const entra = await boton.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
      expect(entra, `el texto de "${name}" se desborda`).toBe(true)
    }
  })

  test('la tarjeta de un pedido con error mide lo mismo que una sana', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await page.getByText('Pedidos en curso').waitFor()

    // El motivo del error no puede estirar la tarjeta a lo alto.
    const alturas = await page
      .locator('li')
      .filter({ hasText: /Buscar|Guardar/ })
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))

    expect(new Set(alturas).size).toBe(1)
  })

  test('nunca se muestra la ubicacion de un slot de pickeo', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')

    // El PUT en error sale del slot 3X01AA1: ese codigo es interno y no puede
    // aparecer en pantalla, ni en el tablero ni en la lista de pedidos.
    await expect(page.getByText('3X01AA1')).toHaveCount(0)
    await expect(page.getByText('3X02AE1')).toHaveCount(0)
  })

  test('se distingue un pedido de picking de uno manual', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')

    await expect(page.getByText('Picking', { exact: true })).toBeVisible()
    await expect(page.getByText('Manual', { exact: true })).toBeVisible()
  })

  test('los objetivos de toque llegan al minimo de la tablet', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')

    const slot = page.getByRole('button', { name: /guardar 3X07AB2/i })
    const box = await slot.boundingBox()

    expect(box?.height ?? 0).toBeGreaterThanOrEqual(56)
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(56)
  })

  test('no hay scroll horizontal en el viewport de la tablet', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )

    expect(overflow).toBe(false)
  })
})

/**
 * La tablet se opera de pie: si hay que scrollear para ver el estado o
 * completar una accion, se usa mal. Estas medidas son faciles de romper sin
 * querer al agregar un campo, asi que quedan fijadas.
 */
test.describe('Todo entra en pantalla', () => {
  async function pageOverflow(page: Page) {
    return page.evaluate(() => ({
      vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }))
  }

  for (const [label, link, marker] of [
    ['pickeo', 'Pickeo', '3X07AB2'],
    ['equipos', 'Equipos', 'Agregar equipo'],
    ['metricas', 'Métricas', 'Cajones más pedidos'],
  ] as const) {
    test(`la vista de ${label} entra sin scroll`, async ({ page }) => {
      await mockApi(page)
      await page.goto('/')
      await page.getByRole('link', { name: link }).click()
      await page.getByText(marker).first().waitFor()

      expect(await pageOverflow(page)).toEqual({ vertical: false, horizontal: false })
    })
  }

  test('el panel de acciones entra sin scroll', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await page.getByRole('button', { name: /pedir o guardar/i }).click()
    await page.getByRole('dialog').waitFor()

    const body = page.getByRole('dialog').locator('> div').last()
    const scrolls = await body.evaluate((el) => el.scrollHeight > el.clientHeight)

    expect(scrolls).toBe(false)
  })
})

test.describe('Navegacion', () => {
  test('las tres rutas son alcanzables', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')

    await page.getByRole('link', { name: 'Equipos' }).click()
    await expect(page.getByRole('heading', { name: 'Equipos', level: 1 })).toBeVisible()

    await page.getByRole('link', { name: 'Métricas' }).click()
    await expect(page.getByRole('heading', { name: 'Métricas', level: 1 })).toBeVisible()

    await page.getByRole('link', { name: 'Pickeo' }).click()
    await expect(page.getByRole('heading', { name: 'Zona de pickeo' })).toBeVisible()
  })

  test('avisa cuando se cae la conexion con el servidor', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await expect(page.getByText('3X07AB2')).toBeVisible()

    await page.route(isApiRequest, (route) => route.abort('failed'))

    // El aviso es persistente y esta en el header, no al pie de una columna.
    await expect(page.getByText('Sin conexión con el servidor')).toBeVisible({ timeout: 30_000 })
    // El ultimo dato bueno sigue en pantalla: vaciar el tablero seria peor.
    await expect(page.getByText('3X07AB2')).toBeVisible()
  })
})
