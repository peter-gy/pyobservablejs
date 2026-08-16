import { toCell } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vite-plus/test";
import { type AttachmentRegistry } from "../src/attachments";
import { createRuntimeDefinition, type RuntimeCellDefinition } from "../src/definition";
import { createRuntime, createRuntimeCleanup, type NotebookOptions } from "../src/environment";
import { runtimeDocument } from "../src/scope";

const baseOptions: NotebookOptions = {
	attachments: {},
	baseUrl: "",
	variables: {},
	showSource: false,
};

describe("runtime document scope", () => {
	test("scopes document selectors to the notebook root", () => {
		const fixture = createScopedDocumentFixture();
		try {
			expect(fixture.scoped.querySelector(".root-marker")).toBe(fixture.root);
			expect([...fixture.scoped.querySelectorAll("h2")].map((node) => node.textContent)).toEqual(["Inside"]);
			expect(fixture.scoped.getElementById('local heading"]')).toBe(fixture.localHeading);
			expect(fixture.scoped.querySelector(".outside-only")).toBeNull();
			expect(fixture.scoped.getElementById("outside-heading")).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});

	test("scopes document collections to notebook content", () => {
		const fixture = createScopedDocumentFixture();
		try {
			expect([...fixture.scoped.getElementsByTagName("h2")].map((node) => node.textContent)).toEqual(["Inside"]);
			expect([...fixture.scoped.getElementsByClassName("slide")].map((node) => node.textContent)).toEqual(["Inside"]);
			expect(fixture.scoped.getElementsByName("probe-form")).toHaveLength(1);
			expect(fixture.scoped.forms).toHaveLength(1);
			expect(fixture.scoped.images).toHaveLength(1);
			expect(fixture.scoped.links).toHaveLength(1);
		} finally {
			fixture.cleanup();
		}
	});

	test("keeps document metadata local to the notebook root", () => {
		const fixture = createScopedDocumentFixture();
		const globalTitle = document.title;
		try {
			const scopedWithState = Object.assign(fixture.scoped, { current: 4 });
			fixture.scoped.title = "Scoped title";

			expect(scopedWithState.current).toBe(4);
			expect(fixture.scoped.title).toBe("Scoped title");
			expect(document.title).toBe(globalTitle);
			expect(fixture.scoped.body).toBe(fixture.root);
			expect(fixture.scoped.head).toBe(fixture.root);
			expect(fixture.scoped.createElement("span").tagName).toBe("SPAN");
			expect(fixture.scoped.baseURI).toBe(document.baseURI);
		} finally {
			fixture.cleanup();
		}
	});

	test("dispatches scoped document events through the notebook root", () => {
		const fixture = createScopedDocumentFixture();
		let rootEvents = 0;
		let globalEvents = 0;
		const onRoot = () => {
			rootEvents += 1;
		};
		const onGlobal = () => {
			globalEvents += 1;
		};
		fixture.scoped.addEventListener("pyobservablejs-probe", onRoot);
		document.addEventListener("pyobservablejs-probe", onGlobal);
		try {
			fixture.scoped.dispatchEvent(new Event("pyobservablejs-probe"));
			expect(rootEvents).toBe(1);
			expect(globalEvents).toBe(0);
		} finally {
			fixture.scoped.removeEventListener("pyobservablejs-probe", onRoot);
			document.removeEventListener("pyobservablejs-probe", onGlobal);
			fixture.cleanup();
		}
	});

	test("binds compiled cells to the scoped document", () => {
		const fixture = createScopedDocumentFixture();
		try {
			const definition = createRuntimeDefinition(
				toCell({ id: 1, mode: "ojs", value: "" }),
				{
					body: 'function(){ return document.querySelector(".root-marker")?.textContent; }',
					inputs: [],
					outputs: [],
					autodisplay: true,
					autoview: false,
					automutable: false,
				} satisfies RuntimeCellDefinition,
				{ document: fixture.scoped },
			);
			expect(definition.body()).toBe("Inside");
		} finally {
			fixture.cleanup();
		}
	});

	test("keeps scoped document collections live", () => {
		const root = document.createElement("div");
		const el = document.createElement("div");
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			disposed: false,
			cleanup() {},
		};
		const runtime = createRuntime(root, el, baseOptions, registry);
		const scoped = runtimeDocument(runtime)!;
		const byClass = scoped.getElementsByClassName("late-entry");
		const byTag = scoped.getElementsByTagName("article");
		const byNamespace = scoped.getElementsByTagNameNS("http://www.w3.org/2000/svg", "circle");
		const byName = scoped.getElementsByName("late-entry");
		const forms = scoped.forms;
		const images = scoped.images;
		const links = scoped.links;

		const article = document.createElement("article");
		article.className = "late-entry";
		article.setAttribute("name", "late-entry");
		const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		const form = document.createElement("form");
		form.id = "late-form";
		const image = document.createElement("img");
		const link = document.createElement("a");
		link.href = "#late";
		root.append(article, circle, form, image, link);

		expect([...byClass]).toEqual([article]);
		expect(byClass.item(0)).toBe(article);
		expect(byTag[0]).toBe(article);
		expect([...byNamespace]).toEqual([circle]);
		expect(byName.item(0)).toBe(article);
		expect(forms.namedItem("late-form")).toBe(form);
		expect([...images]).toEqual([image]);
		expect([...links]).toEqual([link]);

		article.remove();
		circle.remove();
		form.remove();
		image.remove();
		link.remove();
		expect([byClass.length, byTag.length, byNamespace.length, byName.length]).toEqual([0, 0, 0, 0]);
		expect([forms.length, images.length, links.length]).toEqual([0, 0, 0]);
		createRuntimeCleanup(runtime, registry)();
	});

	test("reads the active element inside the notebook shadow root", () => {
		const host = document.createElement("div");
		const shadowRoot = host.attachShadow({ mode: "open" });
		const root = document.createElement("div");
		const input = document.createElement("input");
		root.append(input);
		shadowRoot.append(root);
		document.body.append(host);
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			disposed: false,
			cleanup() {},
		};
		const runtime = createRuntime(root, root, baseOptions, registry);

		try {
			input.focus();
			expect(runtimeDocument(runtime)?.activeElement).toBe(input);
		} finally {
			createRuntimeCleanup(runtime, registry)();
			host.remove();
		}
	});
	test("keeps document selectors isolated across simultaneous runtimes", () => {
		const firstRoot = document.createElement("div");
		firstRoot.classList.add("root-marker");
		const firstTarget = document.createElement("span");
		firstTarget.id = "shared-target";
		firstTarget.classList.add("first-only");
		firstTarget.textContent = "First";
		firstRoot.append(firstTarget);
		const secondRoot = document.createElement("div");
		secondRoot.classList.add("root-marker");
		const secondTarget = document.createElement("span");
		secondTarget.id = "shared-target";
		secondTarget.classList.add("second-only");
		secondTarget.textContent = "Second";
		secondRoot.append(secondTarget);
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			disposed: false,
			cleanup() {},
		};
		const firstRuntime = createRuntime(firstRoot, document.createElement("div"), baseOptions, registry);
		const secondRuntime = createRuntime(secondRoot, document.createElement("div"), baseOptions, registry);

		try {
			const firstDocument = runtimeDocument(firstRuntime)!;
			const secondDocument = runtimeDocument(secondRuntime)!;

			expect(firstDocument.querySelector(".root-marker")).toBe(firstRoot);
			expect(secondDocument.querySelector(".root-marker")).toBe(secondRoot);
			expect(firstDocument.getElementById("shared-target")?.textContent).toBe("First");
			expect(secondDocument.getElementById("shared-target")?.textContent).toBe("Second");
			expect(firstDocument.querySelector(".second-only")).toBeNull();
			expect(secondDocument.querySelector(".first-only")).toBeNull();
		} finally {
			createRuntimeCleanup(firstRuntime, registry)();
			createRuntimeCleanup(secondRuntime, registry)();
		}
	});

	test("releases runtime scope on cleanup", () => {
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			disposed: false,
			cleanup() {},
		};
		const runtime = createRuntime(document.createElement("div"), document.createElement("div"), baseOptions, registry);

		expect(runtimeDocument(runtime)).toBeDefined();
		createRuntimeCleanup(runtime, registry)();

		expect(runtimeDocument(runtime)).toBeUndefined();
	});
});

function createScopedDocumentFixture() {
	const root = document.createElement("div");
	root.classList.add("root-marker");
	const localHeading = document.createElement("h2");
	localHeading.id = 'local heading"]';
	localHeading.classList.add("slide");
	localHeading.textContent = "Inside";
	const localForm = document.createElement("form");
	localForm.setAttribute("name", "probe-form");
	const localImage = document.createElement("img");
	const localLink = document.createElement("a");
	localLink.href = "#inside";
	root.append(localHeading, localForm, localImage, localLink);

	const outside = document.createElement("section");
	outside.id = "outside-heading";
	outside.classList.add("outside-only", "slide");
	const outsideHeading = document.createElement("h2");
	outsideHeading.textContent = "Outside";
	const outsideForm = document.createElement("form");
	outsideForm.setAttribute("name", "probe-form");
	const outsideImage = document.createElement("img");
	const outsideLink = document.createElement("a");
	outsideLink.href = "#outside";
	outside.append(outsideHeading, outsideForm, outsideImage, outsideLink);
	document.body.append(outside);

	const registry: AttachmentRegistry = {
		baseUrl: "",
		names: new Set(),
		blobUrls: new Map(),
		disposed: false,
		cleanup() {},
	};
	const runtime = createRuntime(root, document.createElement("div"), baseOptions, registry);
	const scoped = runtimeDocument(runtime)!;
	return {
		root,
		localHeading,
		scoped,
		cleanup() {
			createRuntimeCleanup(runtime, registry)();
			outside.remove();
		},
	};
}
