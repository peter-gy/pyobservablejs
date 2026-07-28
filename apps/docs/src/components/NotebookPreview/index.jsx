import { useEffect, useRef, useState } from "react";

import styles from "./styles.module.css";

const loadTimeout = 20_000;

function hasRenderedNotebook(root) {
	const notebook = root?.querySelector("marimo-anywidget")?.shadowRoot?.querySelector(".pyobservablejs-notebook");
	return Boolean(notebook?.querySelector("select") && notebook.querySelector("figure svg"));
}

function hasIslandError(root) {
	return Boolean(root?.querySelector(".marimo-island-error"));
}

export default function NotebookPreview({ children, className }) {
	const root = useRef(null);
	const [status, setStatus] = useState("loading");

	useEffect(() => {
		let timer;
		const deadline = window.performance.now() + loadTimeout;

		const check = () => {
			if (hasRenderedNotebook(root.current)) {
				setStatus("ready");
				return;
			}
			if (hasIslandError(root.current)) {
				setStatus("error");
				return;
			}
			if (window.performance.now() >= deadline) {
				setStatus("timeout");
				return;
			}
			timer = window.setTimeout(check, 100);
		};

		check();
		return () => window.clearTimeout(timer);
	}, []);

	const loading = status === "loading";
	const rootClassName = className ? `${styles.root} ${className}` : styles.root;

	return (
		<div ref={root} className={rootClassName} aria-busy={loading}>
			<div className={styles.content} data-loading={loading} aria-hidden={loading}>
				{children}
			</div>
			{loading ? (
				<div className={styles.skeleton} role="status" aria-label="Loading notebook">
					<span className={styles.title} />
					<span className={styles.control} />
					<span className={styles.summary} />
					<span className={styles.legend} />
					<span className={styles.chart} />
				</div>
			) : null}
			{status === "timeout" ? (
				<p className={styles.error} role="alert">
					The notebook preview could not load. Reload the page to try again.
				</p>
			) : null}
		</div>
	);
}
