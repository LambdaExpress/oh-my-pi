import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { GuestSnapshot } from "../../lib/client";

export interface ModelPickerProps {
	snapshot: GuestSnapshot;
	onModelList(): void;
	onModelChange(provider: string, id: string): void;
	disabled?: boolean;
}

/**
 * Session model picker. The host model list is loaded lazily on first open;
 * null therefore means "loading/not requested", while an empty array is a
 * real empty result from the host.
 */
export function ModelPicker({ snapshot, onModelList, onModelChange, disabled = false }: ModelPickerProps): ReactNode {
	const [open, setOpen] = useState(false);
	const menuId = useId();
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const model = snapshot.state?.model;
	const models = snapshot.models;
	const currentId = model?.id;
	const currentProvider = model?.provider;

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	useEffect(() => {
		if (!open) return;
		const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			triggerRef.current?.focus();
		};
		const closeOnOutsidePointer = (event: PointerEvent): void => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("keydown", closeOnEscape);
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		return () => {
			document.removeEventListener("keydown", closeOnEscape);
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
		};
	}, [open]);

	return (
		<div className="sh-model-picker">
			<button
				ref={triggerRef}
				type="button"
				className="sh-model-picker-trigger"
				disabled={disabled}
				onClick={() => {
					if (!open && models === null) onModelList();
					setOpen(value => !value);
				}}
				title="switch model"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
			>
				<span className="sh-model-picker-name">{model?.name ?? "Select model"}</span>
				<ChevronDown size={12} aria-hidden="true" />
			</button>
			{open && (
				<div ref={menuRef} id={menuId} className="sh-model-picker-menu" role="group" aria-label="Models">
					{models === null ? (
						<div className="sh-model-picker-empty" role="status">
							loading models…
						</div>
					) : models.length === 0 ? (
						<div className="sh-model-picker-empty">no models available</div>
					) : (
						models.map(item => {
							const selected = item.id === currentId && item.provider === currentProvider;
							return (
								<button
									key={`${item.provider}/${item.id}`}
									type="button"
									className={selected ? "sh-model-picker-item sh-model-picker-on" : "sh-model-picker-item"}
									aria-pressed={selected}
									onClick={() => {
										setOpen(false);
										onModelChange(item.provider, item.id);
									}}
								>
									<span className="sh-model-picker-item-copy">
										<span className="sh-model-picker-item-name">{item.name}</span>
										<span className="sh-model-picker-item-provider">{item.provider}</span>
									</span>
									{selected && <Check size={13} aria-hidden="true" />}
								</button>
							);
						})
					)}
				</div>
			)}
		</div>
	);
}
