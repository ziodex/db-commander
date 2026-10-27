import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from 'react'

/** Native modality makes the background inert; retain a predictable keyboard
 * loop and return to the invoking control when the dialog is removed. */
export function ModalDialog({ onDismiss, onKeyDown, children, className = '', ...props }: ComponentPropsWithoutRef<'dialog'> & { onDismiss(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const previous = useRef(document.activeElement as HTMLElement | null)
  useLayoutEffect(() => {
    const element = ref.current!, trigger = previous.current
    element.showModal()
    return () => {
      element.close()
      // A confirmation may disable its trigger until this React commit ends.
      // Restore after it is re-enabled, without stealing focus from a new dialog.
      queueMicrotask(() => {
        if (trigger?.isConnected && (document.activeElement === document.body || element.contains(document.activeElement))) trigger.focus()
      })
    }
  }, [])
  return <dialog {...props} ref={ref} className={`modal-dialog ${className}`} role="dialog" aria-modal="true" tabIndex={-1}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onDismiss() }}
    onKeyDown={event => {
      event.stopPropagation()
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      if (event.key !== 'Tab') return
      const controls = [...ref.current!.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
      if (!controls.length) { event.preventDefault(); ref.current?.focus(); return }
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)!.focus() }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
    }}>{children}</dialog>
}
