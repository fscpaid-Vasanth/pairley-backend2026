import { Controller, Get, Query } from '@nestjs/common';
import { CategoryService } from './category.service';

// Publishes the canonical taxonomy so no client has to hardcode the list
// of valid category keys. The frontend keeps its own presentational map
// (icons, colours, gradients) in src/data/categories.js keyed by the same
// strings — this endpoint is what makes that mapping verifiable rather
// than a second, silently-drifting source of truth.
//
// Unauthenticated by design: the taxonomy is public reference data, no
// more sensitive than the category chips already rendered on /deals.
@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  /**
   * GET /categories             -> selectable categories (default)
   * GET /categories?scope=all   -> including non-selectable (`general`)
   * GET /categories?scope=aggregatable -> those eligible for Market
   *                                       Price Intelligence
   */
  @Get()
  list(@Query('scope') scope?: string) {
    const categories =
      scope === 'all'
        ? this.categoryService.listAll()
        : scope === 'aggregatable'
          ? this.categoryService.listAggregatable()
          : this.categoryService.listSelectable();

    return categories.map((c) => ({
      key: c.key,
      displayName: c.displayName,
      aggregatable: c.aggregatable,
      selectable: c.selectable,
    }));
  }
}
