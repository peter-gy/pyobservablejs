import { useEffect, useRef, useState } from "react";

import styles from "./styles.module.css";

const loadTimeout = 20_000;

const plotPoints = [
	[12, 68],
	[18, 55],
	[22, 75],
	[27, 46],
	[31, 63],
	[36, 38],
	[39, 54],
	[45, 44],
	[49, 72],
	[54, 59],
	[58, 79],
	[63, 66],
	[67, 74],
	[70, 51],
	[59, 36],
	[66, 27],
	[73, 42],
	[78, 22],
	[84, 35],
	[89, 16],
];

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
					<span className={`${styles.placeholder} ${styles.title}`} />
					<div className={styles.controlRow}>
						<span className={`${styles.placeholder} ${styles.controlLabel}`} />
						<span className={`${styles.placeholder} ${styles.control}`} />
					</div>
					<span className={`${styles.placeholder} ${styles.summary}`} />
					<div className={styles.legend}>
						<div className={styles.legendItem}>
							<span className={`${styles.placeholder} ${styles.swatch}`} />
							<span className={`${styles.placeholder} ${styles.legendLabel}`} />
						</div>
						<div className={styles.legendItem}>
							<span className={`${styles.placeholder} ${styles.swatch}`} />
							<span className={`${styles.placeholder} ${styles.legendLabel}`} />
						</div>
						<div className={styles.legendItem}>
							<span className={`${styles.placeholder} ${styles.swatch}`} />
							<span className={`${styles.placeholder} ${styles.legendLabel}`} />
						</div>
					</div>
					<div className={styles.chart}>
						<span className={`${styles.placeholder} ${styles.yAxisLabel}`} />
						<div className={styles.plot}>
							<div className={styles.points}>
								{plotPoints.map(([left, top]) => (
									<span className={styles.point} key={`${left}-${top}`} style={{ left: `${left}%`, top: `${top}%` }} />
								))}
							</div>
						</div>
						<span className={`${styles.placeholder} ${styles.xAxisLabel}`} />
					</div>
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
