declare module "*.css";
declare module "*.css?inline" {
	const source: string;
	export default source;
}
