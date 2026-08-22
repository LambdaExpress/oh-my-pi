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

export interface ThinkingPickerProps {
	levels: readonly string[];
	value: string;
	onChange(level: string): void;
	disabled?: boolean;
}

interface ComposerPickerProps<T> {
	items: readonly T[] | null;
	selectedKey: string | undefined;
	triggerLabel: string;
	title: string;
	menuLabel: string;
	loadingLabel: string;
	emptyLabel: string;
	disabled: boolean;
	itemKey(item: T): string;
	itemLabel(item: T): string;
	itemMeta?(item: T): string;
	onOpen?(): void;
	onSelect(item: T): void;
}

const THINKING_LABELS: Readonly<Record<string, string>> = {
	off: "Off",
	auto: "Auto",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

function ComposerPicker<T>({
	items,
	selectedKey,
	triggerLabel,
	title,
	menuLabel,
	loadingLabel,
	emptyLabel,
	disabled,
	itemKey,
	itemLabel,
	itemMeta,
	onOpen,
	onSelect,
}: ComposerPickerProps<T>): ReactNode {
	const [open, setOpen] = useState(false);
	const menuId = useId();
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

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
		<div className="sh-composer-picker">
			<button
				ref={triggerRef}
				type="button"
				className="sh-composer-picker-trigger"
				disabled={disabled}
				onClick={() => {
					if (!open) onOpen?.();
					setOpen(value => !value);
				}}
				title={title}
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
			>
				<span className="sh-composer-picker-name">{triggerLabel}</span>
				<ChevronDown size={12} aria-hidden="true" />
			</button>
			{open && (
				<div ref={menuRef} id={menuId} className="sh-composer-picker-menu" role="group" aria-label={menuLabel}>
					{items === null ? (
						<div className="sh-composer-picker-empty" role="status">
							{loadingLabel}
						</div>
					) : items.length === 0 ? (
						<div className="sh-composer-picker-empty">{emptyLabel}</div>
					) : (
						items.map(item => {
							const key = itemKey(item);
							const selected = key === selectedKey;
							return (
								<button
									key={key}
									type="button"
									className={
										selected ? "sh-composer-picker-item sh-composer-picker-on" : "sh-composer-picker-item"
									}
									aria-pressed={selected}
									onClick={() => {
										setOpen(false);
										onSelect(item);
									}}
								>
									<span className="sh-composer-picker-item-copy">
										<span className="sh-composer-picker-item-name">{itemLabel(item)}</span>
										{itemMeta && <span className="sh-composer-picker-item-meta">{itemMeta(item)}</span>}
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

/** Session model picker. The host model list is loaded lazily on first open. */
export function ModelPicker({ snapshot, onModelList, onModelChange, disabled = false }: ModelPickerProps): ReactNode {
	const model = snapshot.state?.model;
	const models = snapshot.models;
	return (
		<ComposerPicker
			items={models}
			selectedKey={model ? `${model.provider}/${model.id}` : undefined}
			triggerLabel={model?.name ?? "Select model"}
			title="switch model"
			menuLabel="Models"
			loadingLabel="loading models…"
			emptyLabel="no models available"
			disabled={disabled}
			itemKey={item => `${item.provider}/${item.id}`}
			itemLabel={item => item.name}
			itemMeta={item => item.provider}
			onOpen={() => {
				if (models === null) onModelList();
			}}
			onSelect={item => onModelChange(item.provider, item.id)}
		/>
	);
}

/** Thinking-level picker using the same menu interaction and visuals as the model picker. */
export function ThinkingPicker({ levels, value, onChange, disabled = false }: ThinkingPickerProps): ReactNode {
	return (
		<ComposerPicker
			items={levels}
			selectedKey={value}
			triggerLabel={THINKING_LABELS[value] ?? value}
			title="change thinking level"
			menuLabel="Thinking levels"
			loadingLabel=""
			emptyLabel="no thinking levels available"
			disabled={disabled}
			itemKey={level => level}
			itemLabel={level => THINKING_LABELS[level] ?? level}
			onSelect={onChange}
		/>
	);
}
