import { useState, type ReactNode } from 'react'
import {
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  columnFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { cx, Input } from './ui'

export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, datetime: sortFn_datetime },
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
})

export type DataTableFeatures = typeof dataTableFeatures

export function dataColumnHelper<TData extends object>() {
  return createColumnHelper<DataTableFeatures, TData>()
}

export function DataTable<TData extends object>({
  data,
  columns,
  initialSorting = [],
  searchPlaceholder,
  emptyText = 'Keine Einträge vorhanden.',
  onRowClick,
  toolbar,
}: {
  data: TData[]
  columns: ColumnDef<DataTableFeatures, TData, any>[]
  initialSorting?: SortingState
  /** Wenn gesetzt, wird eine clientseitige Volltextsuche angezeigt. */
  searchPlaceholder?: string
  emptyText?: string
  onRowClick?: (row: TData) => void
  toolbar?: ReactNode
}) {
  const [globalFilter, setGlobalFilter] = useState('')
  const table = useTable({
    features: dataTableFeatures,
    data,
    columns,
    initialState: { sorting: initialSorting },
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: 'includesString',
  })

  const rows = table.getRowModel().rows

  return (
    <div className="space-y-3">
      {searchPlaceholder || toolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          {searchPlaceholder ? (
            <Input
              type="search"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={searchPlaceholder}
              className="max-w-xs"
            />
          ) : null}
          {toolbar}
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  const canSort = header.column.getCanSort()
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                      className="px-3 py-2 text-left font-medium whitespace-nowrap text-slate-600"
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 hover:text-slate-900"
                        >
                          <table.FlexRender header={header} />
                          <span aria-hidden className="text-xs text-slate-400">
                            {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}
                          </span>
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={table.getAllLeafColumns().length} className="px-3 py-8 text-center text-slate-500">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={cx(onRowClick && 'cursor-pointer hover:bg-slate-50')}
                >
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 align-top">
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
