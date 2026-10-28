package magpie

import (
	"sync"
	"sync/atomic"
)

// Engine owns one conversation's secret mapping. Never share between tenants.
type Engine struct {
	keyOf     []byte
	keyPath   string
	kinds     map[string]bool
	known     map[string][]knownValue
	knownBits [1 << 14]uint64
	knownGen  atomic.Uint64
	mu        sync.RWMutex
	scrubMemo memo
	scrubRuns atomic.Uint64
	sentKnown struct {
		sync.Mutex
		cur, old map[[32]byte][]span
	}
	shapes map[string]string
	values map[string]string
}

func New() *Engine {
	engine := &Engine{}
	engine.kinds = map[string]bool{}
	engine.known = map[string][]knownValue{}
	engine.shapes = map[string]string{}
	engine.values = map[string]string{}
	return engine
}

// Detect returns offsets without retaining values in the mapping.
func (engine *Engine) Detect(s string, o Options) []Hit {
 o.engine=engine
 var hits []Hit
 o.Seen=func(h Hit){hits=append(hits,h)}
 engine.mask(s,withModel(o,[]string{s}),engine.tag,false)
 return hits
}

// Close drops all recoverable values. Callers must finish responses first.
func (engine *Engine) Close() {
 engine.mu.Lock()
 defer engine.mu.Unlock()
 clear(engine.keyOf)
 engine.keyOf=nil
 clear(engine.values);clear(engine.kinds);clear(engine.shapes);clear(engine.known)
 engine.knownBits=[1<<14]uint64{}
 engine.knownGen.Add(1)
 engine.resetSent()
 engine.scrubMemo.reset()
}
