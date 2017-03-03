const {Emitter} = require('event-kit')
const Decoration = require('./decoration')
const LayerDecoration = require('./layer-decoration')

module.exports =
class DecorationManager {
  constructor (displayLayer) {
    this.displayLayer = displayLayer

    this.emitter = new Emitter()
    this.decorationCountsByLayer = new Map()
    this.decorationsByMarker = new Map()
    this.layerDecorationsByMarkerLayer = new Map()
    this.overlayDecorations = new Set()
    this.layerUpdateDisposablesByLayer = new WeakMap()
  }

  observeDecorations (callback) {
    for (let decoration of this.getDecorations()) { callback(decoration) }
    return this.onDidAddDecoration(callback)
  }

  onDidAddDecoration (callback) {
    return this.emitter.on('did-add-decoration', callback)
  }

  onDidRemoveDecoration (callback) {
    return this.emitter.on('did-remove-decoration', callback)
  }

  onDidUpdateDecorations (callback) {
    return this.emitter.on('did-update-decorations', callback)
  }

  getDecorations (propertyFilter) {
    let allDecorations = []

    this.decorationsByMarker.forEach((decorations) => {
      decorations.forEach((decoration) => allDecorations.push(decoration))
    })
    if (propertyFilter != null) {
      allDecorations = allDecorations.filter(function (decoration) {
        for (let key in propertyFilter) {
          const value = propertyFilter[key]
          if (decoration.properties[key] !== value) return false
        }
        return true
      })
    }
    return allDecorations
  }

  getLineDecorations (propertyFilter) {
    return this.getDecorations(propertyFilter).filter(decoration => decoration.isType('line'))
  }

  getLineNumberDecorations (propertyFilter) {
    return this.getDecorations(propertyFilter).filter(decoration => decoration.isType('line-number'))
  }

  getHighlightDecorations (propertyFilter) {
    return this.getDecorations(propertyFilter).filter(decoration => decoration.isType('highlight'))
  }

  getOverlayDecorations (propertyFilter) {
    const result = []
    result.push(...Array.from(this.overlayDecorations))
    if (propertyFilter != null) {
      return result.filter(function (decoration) {
        for (let key in propertyFilter) {
          const value = propertyFilter[key]
          if (decoration.properties[key] !== value) {
            return false
          }
        }
        return true
      })
    } else {
      return result
    }
  }

  decorationsForScreenRowRange (startScreenRow, endScreenRow) {
    const decorationsByMarkerId = {}
    for (const layer of this.decorationCountsByLayer.keys()) {
      for (const marker of layer.findMarkers({intersectsScreenRowRange: [startScreenRow, endScreenRow]})) {
        const decorations = this.decorationsByMarker.get(marker)
        if (decorations) {
          decorationsByMarkerId[marker.id] = Array.from(decorations)
        }
      }
    }
    return decorationsByMarkerId
  }

  decorationsStateForScreenRowRange (startScreenRow, endScreenRow) {
    const decorationsState = {}

    for (const layer of this.decorationCountsByLayer.keys()) {
      for (const marker of layer.findMarkers({intersectsScreenRowRange: [startScreenRow, endScreenRow]})) {
        if (marker.isValid()) {
          const screenRange = marker.getScreenRange()
          const bufferRange = marker.getBufferRange()
          const rangeIsReversed = marker.isReversed()

          const decorations = this.decorationsByMarker.get(marker.id)
          if (decorations) {
            decorations.forEach((decoration) => {
              decorationsState[decoration.id] = {
                properties: decoration.properties,
                screenRange,
                bufferRange,
                rangeIsReversed
              }
            })
          }

          const layerDecorations = this.layerDecorationsByMarkerLayer.get(layer)
          if (layerDecorations) {
            layerDecorations.forEach((layerDecoration) => {
              const properties = layerDecoration.overridePropertiesByMarkerId[marker.id] != null ? layerDecoration.overridePropertiesByMarkerId[marker.id] : layerDecoration.properties
              decorationsState[`${layerDecoration.id}-${marker.id}`] = {
                properties,
                screenRange,
                bufferRange,
                rangeIsReversed
              }
            })
          }
        }
      }
    }

    return decorationsState
  }

  decorateMarker (marker, decorationParams) {
    if (marker.isDestroyed()) {
      const error = new Error('Cannot decorate a destroyed marker')
      error.metadata = {markerLayerIsDestroyed: marker.layer.isDestroyed()}
      if (marker.destroyStackTrace != null) {
        error.metadata.destroyStackTrace = marker.destroyStackTrace
      }
      if (marker.bufferMarker != null && marker.bufferMarker.destroyStackTrace != null) {
        error.metadata.destroyStackTrace = marker.bufferMarker.destroyStackTrace
      }
      throw error
    }
    marker = this.displayLayer.getMarkerLayer(marker.layer.id).getMarker(marker.id)
    const decoration = new Decoration(marker, this, decorationParams)
    let decorationsForMarker = this.decorationsByMarker.get(marker)
    if (!decorationsForMarker) {
      decorationsForMarker = new Set()
      this.decorationsByMarker.set(marker, decorationsForMarker)
    }
    decorationsForMarker.add(decoration)
    if (decoration.isType('overlay')) this.overlayDecorations.add(decoration)
    this.observeDecoratedLayer(marker.layer)
    this.emitDidUpdateDecorations()
    this.emitter.emit('did-add-decoration', decoration)
    return decoration
  }

  decorateMarkerLayer (markerLayer, decorationParams) {
    if (markerLayer.isDestroyed()) {
      throw new Error('Cannot decorate a destroyed marker layer')
    }
    const decoration = new LayerDecoration(markerLayer, this, decorationParams)
    let layerDecorations = this.layerDecorationsByMarkerLayer.get(markerLayer)
    if (layerDecorations == null) {
      layerDecorations = new Set()
      this.layerDecorationsByMarkerLayer.set(markerLayer, layerDecorations)
    }
    layerDecorations.add(decoration)
    this.observeDecoratedLayer(markerLayer)
    this.emitDidUpdateDecorations()
    return decoration
  }

  emitDidUpdateDecorations () {
    this.emitter.emit('did-update-decorations')
  }

  decorationDidChangeType (decoration) {
    if (decoration.isType('overlay')) {
      this.overlayDecorations.add(decoration)
    } else {
      this.overlayDecorations.delete(decoration)
    }
  }

  didDestroyMarkerDecoration (decoration) {
    const {marker} = decoration
    const decorations = this.decorationsByMarker.get(marker)
    if (decorations && decorations.has(decoration)) {
      decorations.delete(decoration)
      if (decorations.size === 0) this.decorationsByMarker.delete(marker)
      this.overlayDecorations.delete(decoration)
      this.unobserveDecoratedLayer(marker.layer)
      this.emitter.emit('did-remove-decoration', decoration)
      this.emitDidUpdateDecorations()
    }
  }

  didDestroyLayerDecoration (decoration) {
    const {markerLayer} = decoration
    const decorations = this.layerDecorationsByMarkerLayer.get(markerLayer)

    if (decorations && decorations.has(decoration)) {
      decorations.delete(decoration)
      if (decorations.size === 0) {
        this.layerDecorationsByMarkerLayer.delete(markerLayer)
      }
      this.unobserveDecoratedLayer(markerLayer)
      this.emitDidUpdateDecorations()
    }
  }

  observeDecoratedLayer (layer) {
    const newCount = (this.decorationCountsByLayer.get(layer) || 0) + 1
    this.decorationCountsByLayer.set(layer, newCount)
    if (newCount === 1) {
      this.layerUpdateDisposablesByLayer.set(layer, layer.onDidUpdate(this.emitDidUpdateDecorations.bind(this)))
    }
  }

  unobserveDecoratedLayer (layer) {
    const newCount = this.decorationCountsByLayer.get(layer) - 1
    if (newCount === 0) {
      this.layerUpdateDisposablesByLayer.get(layer).dispose()
      this.decorationCountsByLayer.delete(layer)
    } else {
      this.decorationCountsByLayer.set(layer, newCount)
    }
  }
}
