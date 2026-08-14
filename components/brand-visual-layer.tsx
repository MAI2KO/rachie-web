import type { ActiveBrand } from "@/brands/config";

interface BrandVisualLayerProps {
  readonly brand: ActiveBrand;
}

export function BrandVisualLayer({ brand }: BrandVisualLayerProps) {
  return (
    <div
      aria-hidden="true"
      className="brand-visual-layer"
      data-asset-base-path={brand.assets.basePath}
      data-asset-namespace={brand.assets.namespace}
    />
  );
}
