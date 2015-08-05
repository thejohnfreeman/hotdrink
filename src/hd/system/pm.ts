/*********************************************************************
 * A PropertyModel's duties are
 *   1. Translate a model into a constraint graph
 *   2. Watch the variables to see when they change
 *   3. Run the planner to get a new solution graph
 *   4. Run the evaluator to produce new values
 */
module hd.config {
  export
  var defaultPlannerType: hd.plan.PlannerType = hd.plan.QuickPlanner;

  export
  var forwardEmergingSources = false;
}

module hd.system {

  import u = hd.utility;
  import r = hd.reactive;
  import m = hd.model;
  import g = hd.graph;
  import p = hd.plan;
  import e = hd.enable;
  import c = hd.config;

  // scheduling priority for responding to state changes
  export var SystemUpdatePriority = 1;

  /*==================================================================
   * The constraint system
   */
  export class PropertyModel {

    // The constraint graph
    private cgraph: g.ConstraintGraph;
    getCGraph(): g.ReadOnlyConstraintGraph { return this.cgraph; }

    // The current solution graph
    private sgraph: g.SolutionGraph = null;
    getSGraph(): g.ReadOnlyConstraintGraph { return this.sgraph; }

    // Topological sorting of solution graph w.r.t. priority
    private topomids: string[];

    // The planning algorithm
    private planner: p.Planner;
    getPlanner() {
      if (! this.planner) {
        this.planner = new c.defaultPlannerType( this.cgraph );
      }
      return this.planner;
    }

    // Lookup tables - convert ids back to objects
    variables:   u.Dictionary<m.Variable>   = {};
    methods:     u.Dictionary<m.Method>     = {};
    constraints: u.Dictionary<m.Constraint> = {};

    // Update strategy
    scheduleUpdateOnChange = true;
    isUpdateScheduled = false;

    // Flag to report when system is solved (no pending variables)
    solved = new r.ScheduledSignal( true );
    private pendingCount = 0;

    // Changes requiring an update
    private needUpdating: u.ArraySet<m.Context> = [];
    private needEnforcing: u.StringSet = {};
    private needEvaluating: u.StringSet = {};

    // Flage indicating when update is needed --
    //   i.e. when one of the above elements is non-empty
    private isUpdateNeeded = false;

    // Touch dependencies
    private touchDeps: u.Dictionary<u.ArraySet<string>> = {};

    // Enablement
    enable: e.EnablementManager = new e.EnablementManager();
    outputVids: u.Dictionary<number> = {};

    private hasOptionals: boolean;

    /*----------------------------------------------------------------
     * Initialize members
     */
    constructor( plannerT: p.PlannerType = c.defaultPlannerType,
                 cgraphT: g.ConstraintGraphType = g.CachingConstraintGraph ) {
      this.cgraph = new cgraphT();
      if (plannerT) {
        this.planner = new plannerT( this.cgraph );
      }
      this.enable.egraph.addObserver( this, this.onNextEgraph, null, null );
    }

    /*----------------------------------------------------------------
     * Replace existing planner with new planner.
     */
    switchToNewPlanner( plannerT: p.PlannerType ) {
      var newPlanner = new plannerT( this.cgraph );
      if (this.planner) {
        var oldPlanner = this.planner;
        newPlanner.setOptionals( oldPlanner.getOptionals() );
      }
      this.planner = newPlanner;
      this.cgraph.constraints().forEach( this.recordConstraintChange, this );
    }

    /*----------------------------------------------------------------
     * Add and remove elements to and from the property model
     */

    //--------------------------------------------
    // Add context
    addComponents( ...contexts: m.Context[] ): void;
    addComponents( contexts: m.Context[] ): void;
    addComponents(): void {
      var contexts: m.Context[] = [];
      var q: m.Context[];
      if (arguments.length == 1 && Array.isArray( arguments[0] )) {
        q = arguments[0];
      }
      else {
        q = Array.prototype.slice.call( arguments, 0 );
      }
      for (var i = 0, l = q.length; i < l; ++i) {
        if (! (q[i] instanceof m.Context)) {
          console.error( "Invalid component passed to PropertyModel.addComponents: " + q[i] );
        }
        else {
          contexts.push( q[i] );
        }
      }

      // Collect all contexts; subscribe to all
      while (q.length > 0) {
        var ctx = q.shift();
        m.Context.changes( ctx ).addObserver( this, this.recordContextChange, null, null );
        if (m.Context.hasUpdates( ctx )) {
          this.recordContextChange( ctx );
        }
        var ns = m.Context.nesteds( ctx );
        if (ns.length) {
          contexts.push.apply( contexts, ns );
          q.push.apply( q, ns );
        }
      }

      // Add variables
      for (var i = 0, l = contexts.length; i < l; ++i) {
        var vs = m.Context.variables( contexts[i] );
        for (var j = 0, n = vs.length; j < n; ++j) {
          if (vs[j].optional === m.Optional.Max) {
            this.addVariable( vs[j] );
          }
        }
        for (var j = vs.length - 1; j >= 0; --j) {
          if (vs[j].optional === m.Optional.Min) {
            this.addVariable( vs[j] );
          }
        }
      }

      // Add constraints
      for (var i = 0, l = contexts.length; i < l; ++i) {
        var cs = m.Context.constraints( contexts[i] );
        for (var j = 0, n = cs.length; j < n; ++j) {
          this.addConstraint( cs[j] );
        }
      }

      // Add outputs
      for (var i = 0, l = contexts.length; i < l; ++i) {
        var os = m.Context.outputs( contexts[i] );
        for (var j = 0, n = os.length; j < n; ++j) {
          this.addOutput( os[j].variable );
        }
      }

      // Add touch dependencies
      for (var i = 0, l = contexts.length; i < l; ++i) {
        var ts = m.Context.touchDeps( contexts[i] );
        for (var j = 0, n = ts.length; j < n; ++j) {
          this.addTouchDependency( ts[j].from, ts[j].to );
        }
      }

    }

    //--------------------------------------------
    // Remove context
    removeComponents( ...contexts: m.Context[] ): void;
    removeComponents( contexts: m.Context[] ): void;
    removeComponents(): void {
      var contexts: m.Context[] = [];
      var q: m.Context[];
      if (arguments.length == 1 && Array.isArray( arguments[0] )) {
        q = arguments[0];
      }
      else {
        q = Array.prototype.slice.call( arguments, 0 );
      }
      for (var i = 0, l = q.length; i < l; ++i) {
        if (! (q[i] instanceof m.Context)) {
          console.error( "Invalid component passed to PropertyModel.addComponents: " + q[i] );
        }
        else {
          contexts.push( q[i] );
        }
      }

      // Collect all contexts; unsubscribe to all
      while (q.length > 0) {
        var ctx = q.shift();
        m.Context.changes( ctx ).removeObserver( this );
        this.removeContextRecords( ctx );
        var ns = m.Context.nesteds( ctx );
        if (ns.length) {
          contexts.push.apply( contexts, ns );
          q.push.apply( q, ns );
        }
      }

      // Remove touch dependencies
      for (var i = 0, l = contexts.length; i < l; ++i) {
        var ts = m.Context.touchDeps( contexts[i] );
        for (var j = 0, n = ts.length; j < n; ++j) {
          this.removeTouchDependency( ts[j].from, ts[j].to );
        }
      }

      // Remove outputs
      for (var i = 0, l = contexts.length; i < l; ++i) {
        var os = m.Context.outputs( contexts[i] );
        for (var j = 0, n = os.length; j < n; ++j) {
          this.removeOutput( os[j].variable );
        }
      }

      // Remove constraints
      for (var i = 0, l = contexts.length; i < l; ++i) {
        var cs = m.Context.constraints( contexts[i] );
        for (var j = 0, n = cs.length; j < n; ++j) {
          this.removeConstraint( cs[j] );
        }
      }

      // Remove variables
      for (var i = 0, l = contexts.length; i < l; ++i) {
        var vs = m.Context.variables( contexts[i] );
        for (var j = 0, n = vs.length; j < n; ++j) {
          this.removeVariable( vs[j] );
        }
      }
    }

    //--------------------------------------------
    // Add variable
    addVariable( vv: m.Variable ) {
      if (! (vv.id in this.variables)) {
        this.variables[vv.id] = vv;

        // Watch for variable events
        if (vv.pending.get()) {
          ++this.pendingCount;
        }
        vv.changes.addObserver( this, this.onNextVariableChange, null, null );

        // Create stay constraint
        var stayMethodId = g.stayMethod( vv.id );
        var stayConstraintId = g.stayConstraint( vv.id );

        // Add variable+stay to existing graphs
        this.cgraph.addVariable( vv.id );
        this.cgraph.addMethod( stayMethodId, stayConstraintId, [], [vv.id] );

        // Set stay to optional
        if (vv.optional === m.Optional.Max) {
          this.getPlanner().setMaxStrength( stayConstraintId );
        }
        else if (vv.optional === m.Optional.Min) {
          this.getPlanner().setMinStrength( stayConstraintId );
        }

        // Mark stay constraint as changed
        this.recordConstraintChange( stayConstraintId );
      }
    }

    //--------------------------------------------
    // Remove variable
    removeVariable( vv: m.Variable ) {
      if ((vv.id in this.variables) &&
          this.cgraph.constraintsWhichUse( vv.id ).length == 0) {
        var stayConstraintId = g.stayConstraint( vv.id );

        // Remove all references
        delete this.variables[vv.id];
        delete this.outputVids[vv.id];
        this.removeConstraintRecords( stayConstraintId );
        vv.changes.removeObserver( this );

        // Remove from graphs
        this.cgraph.removeMethod( g.stayMethod( vv.id ) );
        this.planner.removeOptional( stayConstraintId );
        this.cgraph.removeVariable( vv.id );
      }
    }

    //--------------------------------------------
    // Add constraint
    addConstraint( cc: m.Constraint ) {
      if (! (cc.id in this.constraints)) {
        this.constraints[cc.id] = cc;

        cc.methods.forEach( this.addMethod.bind( this, cc.id ) );

        if (cc.optional === m.Optional.Max) {
          this.getPlanner().setMaxStrength( cc.id );
          this.hasOptionals = true;
        }
        else if (cc.optional === m.Optional.Min) {
          this.getPlanner().setMinStrength( cc.id );
          this.hasOptionals = true;
        }

        // Mark for update
        this.recordConstraintChange( cc.id );
      }
    }

    //--------------------------------------------
    // Remove constraint
    removeConstraint( cc: m.Constraint ) {
      if (cc.id in this.constraints) {
        delete this.constraints[cc.id];
        this.removeConstraintRecords( cc.id );

        cc.methods.forEach( this.removeMethod, this );

        this.sgraph.selectMethod( cc.id, null );
        this.enable.methodScheduled( cc.id, null );
      }
    }

    //--------------------------------------------
    // Add method
    private
    addMethod( cid: string, mm: m.Method ) {
      if (! (mm.id in this.methods)) {
        this.methods[mm.id] = mm;

        // Add to constraint graph
        this.cgraph.addMethod( mm.id,
                               cid,
                               mm.inputVars.map( u.getId ),
                               mm.outputs.map( u.getId )
                             );
      }
    }

    //--------------------------------------------
    // Remove method
    private
    removeMethod( mm: m.Method ) {
      if (mm.id in this.methods) {
        delete this.methods[mm.id];

        // Remove from constraint graph
        this.cgraph.removeMethod( mm.id );
      }
    }

    //--------------------------------------------
    // Add output
    addOutput( out: m.Variable ) {
      var id = out.id;
      if (id in this.outputVids) {
        ++this.outputVids[id];
      }
      else {
        this.outputVids[id] = 1;
      }
    }

    //--------------------------------------------
    // Remove output
    removeOutput( out: m.Variable ) {
      var id = out.id;
      if (this.outputVids[id] > 1) {
        --this.outputVids[id];
      }
      else {
        delete this.outputVids[out.id];
      }
    }

    //--------------------------------------------
    // Add touch dependency
    addTouchDependency( cc1: (m.Constraint|m.Variable),
                        cc2: (m.Constraint|m.Variable) ) {
      var cid1: string, cid2: string;
      if (cc1 instanceof m.Variable) {
        cid1 = g.stayConstraint( cc1.id );
      }
      else {
        cid1 = cc1.id;
      }
      if (cc2 instanceof m.Variable) {
        cid2 = g.stayConstraint( cc2.id );
      }
      else {
        cid2 = cc2.id;
      }

      if (this.touchDeps[cid1]) {
        u.arraySet.add( this.touchDeps[cid1], cid2 );
      }
      else {
        this.touchDeps[cid1] = [cid2];
      }
    }

    addTouchDependencies( cc1: (m.Constraint|m.Variable),
                          cc2s: (m.Constraint|m.Variable)[] ) {
      for (var i = 0, l = cc2s.length; i < l; ++i) {
        this.addTouchDependency( cc1, cc2s[i] );
      }
    }

    addTouchSet( ccs: (m.Constraint|m.Variable)[] ) {
      for (var i = 0, l = ccs.length; i < l; ++i) {
        for (var j = 0; j < l; ++j) {
          if (i != j) {
            this.addTouchDependency( ccs[i], ccs[j] );
          }
        }
      }
    }

    //--------------------------------------------
    // Remove touch dependency
    removeTouchDependency( cc1: (m.Constraint|m.Variable),
                           cc2: (m.Constraint|m.Variable) ) {
      var cid1: string, cid2: string;
      if (cc1 instanceof m.Variable) {
        cid1 = g.stayConstraint( (<m.Variable>cc1).id );
      }
      else {
        cid1 = (<m.Constraint>cc1).id;
      }
      if (cc2 instanceof m.Variable) {
        cid2 = g.stayConstraint( (<m.Variable>cc2).id );
      }
      else {
        cid2 = (<m.Constraint>cc2).id;
      }

      var deps = this.touchDeps[cid1];
      if (deps) {
        u.arraySet.remove( this.touchDeps[cid1], cid2 );
      }
    }

    removeTouchDependencies( cc1: (m.Constraint|m.Variable),
                             cc2s: (m.Constraint|m.Variable)[] ) {
      for (var i = 0, l = cc2s.length; i < l; ++i) {
        this.removeTouchDependency( cc1, cc2s[i] );
      }
    }

    removeTouchSet( ccs: (m.Constraint|m.Variable)[] ) {
      for (var i = 0, l = ccs.length; i < l; ++i) {
        for (var j = 0; j < l; ++j) {
          if (i != j) {
            this.removeTouchDependency( ccs[i], ccs[j] );
          }
        }
      }
    }

    /*----------------------------------------------------------------
     * Respond to variable changes
     */

    //--------------------------------------------
    // Dispatcher
    onNextVariableChange( event: m.VariableEvent ) {
      switch (event.type) {

      case m.VariableEventType.touched:
        this.variableTouched( event.vv );
        break;

      case m.VariableEventType.changed:
        this.variableChanged( event.vv );
        break;

      case m.VariableEventType.pending:
        ++this.pendingCount;
        break;

      case m.VariableEventType.settled:
        if (this.pendingCount > 0) {
          --this.pendingCount;
          if (this.pendingCount == 0 && ! this.isUpdateNeeded) {
            this.solved.set( true );
          }
        }
        break;
      }
    }

    //--------------------------------------------
    // Touch variable and all touch dependencies
    private
    doPromotions( originalVid: string ) {
      var planner = this.getPlanner();
      var descending = function( cid1: string, cid2: string ) {
        return planner.compare( cid2, cid1 );
      };

      var promote: string[] = [];
      var i = 0;
      var visited: u.StringSet = {};
      promote.push( originalVid );
      visited[originalVid] = true;

      while (i < promote.length) {
        var l = promote.length;
        var sub: string[] = [];
        while (i < l) {
          var vid = promote[i++];
          var deps = this.touchDeps[vid];
          if (deps) {
            deps.forEach( function( dep: string ) {
              if (! visited[dep] && this.constraints[dep].optional !== m.Optional.Default) {
                sub.push( dep );
                visited[dep] = true;
              }
            }, this );
          }
        }
        promote.push.apply( promote, sub.sort( descending ) );
      }

      for (--i; i >= 0; --i) {
        var cid = promote[i];
        planner.setMaxStrength( cid );
        if (! this.sgraph ||
            ! this.sgraph.selectedForConstraint( cid )) {
          this.recordConstraintChange( cid );
        }
      }
    }

    //--------------------------------------------
    // Promote variable
    variableTouched( vv: m.Variable ) {
      var stayConstraintId = g.stayConstraint( vv.id );
      this.doPromotions( stayConstraintId );
    }

    //--------------------------------------------
    // Promote variable and mark as changed
    variableChanged( vv: m.Variable ) {
      var stayConstraintId = g.stayConstraint( vv.id );
      this.doPromotions( stayConstraintId );
      this.recordVariableChange( stayConstraintId );
    }

    /*----------------------------------------------------------------
     * Changes to the model are recorded for the next update.  These
     * functions add-to/remove-from those records.
     */

    //--------------------------------------------
    // Context reference has changed; need to query for adds/drops
    private
    recordContextChange( ctx: m.Context ) {
      u.arraySet.add( this.needUpdating, ctx );
      this.recordChange();
    }

    //--------------------------------------------
    // New or promoted constraint; need to replan so we can enforce
    private
    recordConstraintChange( ccid: string ) {
      this.needEnforcing[ccid] = true;
      this.recordChange();
    }

    //--------------------------------------------
    // Variable value has changed; need to evaluate downstream
    private
    recordVariableChange( stayid: string ) {
      this.needEvaluating[stayid] = true;
      this.recordChange();
    }

    //--------------------------------------------
    // Record that update needed; schedule if appropriate
    private
    recordChange() {
      this.isUpdateNeeded = true;
      this.solved.set( false );
      if (this.scheduleUpdateOnChange) {
        this.scheduleUpdate();
      }
    }

    //--------------------------------------------
    // Remove any record of constraint
    //
    private
    removeConstraintRecords( ccid: string ) {
      delete this.needEnforcing[ccid];
      delete this.needEvaluating[ccid];
    }

    //--------------------------------------------
    // Remove any record of context
    private
    removeContextRecords( ctx: m.Context ) {
      u.arraySet.remove( this.needUpdating, ctx );
    }

    /*----------------------------------------------------------------
     */
    private
    scheduleUpdate() {
      if (! this.isUpdateScheduled) {
        this.isUpdateScheduled = true;
        u.schedule( SystemUpdatePriority, this.performScheduledUpdate, this );
      }
    }

    private
    performScheduledUpdate() {
      this.isUpdateScheduled = false;
      this.update();
    }

    /*----------------------------------------------------------------
     */
    update() {
      if (this.isUpdateNeeded) {
        this.isUpdateNeeded = false;
        this.updateModel();
        this.plan();
        this.evaluate();
        if (this.pendingCount == 0) {
          this.solved.set( true );
        }
      }
    }

    /*----------------------------------------------------------------
     */
    private
    updateModel() {
      for (var i = 0, l = this.needUpdating.length; i < l; ++i) {
        var ctx = this.needUpdating[i];
        var updates = m.Context.reportUpdates( ctx );
        for (var i = 0, l = updates.removes.length; i < l; ++i) {
          var el = updates.removes[i];
          if (el instanceof m.Constraint) {
            this.removeConstraint( el );
          }
          else if (el instanceof m.Output) {
            this.removeOutput( el.variable );
          }
          else if (el instanceof m.TouchDep) {
            this.removeTouchDependency( el.from, el.to );
          }
        }
        for (var i = 0, l = updates.adds.length; i < l; ++i) {
          var el = updates.adds[i];
          if (el instanceof m.Constraint) {
            this.addConstraint( el );
          }
          else if (el instanceof m.Output) {
            this.addOutput( el.variable );
          }
          else if (el instanceof m.TouchDep) {
            this.addTouchDependency( el.from, el.to );
          }
        }
      }
    }

    /*----------------------------------------------------------------
     * Update solution graph & dependent info.
     */
    plan() {
      var cids = u.stringSet.members( this.needEnforcing );

      if (cids.length > 0) {

        // Run planner
        if (this.planner.plan( this.sgraph, cids )) {
          this.sgraph = this.planner.getSGraph();

          // Topological sort of all mids and vids
          var tgraph = topograph( this.cgraph, this.sgraph );
          this.topomids = toposort( tgraph, this.planner );
          var priorities: string[] = [];
          for (var i = this.topomids.length - 1; i >= 0; --i) {
            var cid = tgraph.constraintForMethod( this.topomids[i] );
            if (g.isStayConstraint( cid ) ||
                this.constraints[cid].optional) {
              priorities.push( cid );
            }
          }

          // Update stay strengths
          this.planner.setOptionals( priorities );

          // New constraints need to be evaluated
          cids.forEach( u.stringSet.add.bind( null, this.needEvaluating ) );

          // Reevaluate any emerging source variables
          if (config.forwardEmergingSources) {
            this.sgraph.variables().forEach( this.reevaluateIfEmergingSource, this );
          }

          // Update source statuses
          this.sgraph.variables().forEach( this.updateSourceStatus, this );
        }

        this.needEnforcing = {};
      }
    }


    // Helper - check for source variables that
    private
    reevaluateIfEmergingSource( vid: string ) {
      var vv = this.variables[vid];
      var stayConstraintId = g.stayConstraint( vid );

      // Evaluate if it's selected AND not previously a source
      //   AND not currently scheduled for evaluation
      if (this.sgraph.selectedForConstraint( stayConstraintId ) &&
          ! vv.source.get() && ! this.needEvaluating[stayConstraintId]) {

        vv.makePromise( vv.getForwardedPromise() );
        this.needEvaluating[stayConstraintId] = true;
      }
    }

    // Helper - set source property based on current solution graph
    private
    updateSourceStatus( vid: string ) {
      if (this.sgraph.selectedForConstraint( g.stayConstraint( vid ) )) {
        this.variables[vid].source.set( true );
      }
      else {
        this.variables[vid].source.set( false );
      }
    }

    /*----------------------------------------------------------------
     * Run any methods which need updating.
     */
    evaluate() {
      var mids = u.stringSet.members( this.needEvaluating )
            .map( function( cid: string ) {
              return this.sgraph.selectedForConstraint( cid );
            }, this )
            .filter( u.isNotNull );

      var downstreamVids = new g.DigraphWalker( this.sgraph.graph )
            .nodesDownstreamOtherType( mids );

        // Commit initial edits
        for (var i = 0, l = downstreamVids.length; i < l; ++i) {
          var vid = downstreamVids[i];
          this.variables[vid].commitPromise();
        }

      if (mids.length > 0) {
        // Collect methods to be run
        var downstreamMids = new g.DigraphWalker( this.sgraph.graph )
              .nodesDownstreamSameType( mids )
              .filter( g.isNotStayMethod )
              .reduce( u.stringSet.build, <u.StringSet>{} );
        var scheduledMids = this.topomids
              .filter( function( mid: string ) { return downstreamMids[mid]; } );

        // Evaluate methods
        for (var i = 0, l = scheduledMids.length; i < l; ++i) {
          var mid = scheduledMids[i];
          var ar = this.methods[mid].activate();
          this.enable.methodScheduled( this.cgraph.constraintForMethod( mid ),
                                       mid,
                                       ar.inputs,
                                       ar.outputs
                                     );
        }

        // Commit all output promises
        for (var i = 0, l = downstreamVids.length; i < l; ++i) {
          var vid = downstreamVids[i];
          this.variables[vid].commitPromise();
        }

        this.needEvaluating = {};
      }
    }

    /*----------------------------------------------------------------
     */
    onNextEgraph( egraph: e.EnablementLabels ) {
      var outputVids = u.stringSet.members( this.outputVids );
      if (outputVids.length) {
        var labels = e.globalContributingCheck( this.sgraph,
                                                egraph,
                                                outputVids
                                              );
        for (var vid in this.variables) {
          var vv = this.variables[vid];
          if (labels[vid] === e.Label.Relevant) {
            vv.contributing.set( u.Fuzzy.Yes );
            vv.relevant.set( u.Fuzzy.Yes );
          }
          else if (labels[vid] === e.Label.AssumedRelevant) {
            vv.contributing.set( u.Fuzzy.Maybe );
            vv.relevant.set( u.Fuzzy.Maybe );
          }
          else {
            vv.contributing.set( u.Fuzzy.No );
            vv.relevant.set( e.relevancyCheck( this.cgraph,
                                               this.enable.egraph,
                                               <any>this.outputVids,
                                               vid
                                             )
                           );
          }
        }
      }
    }

  }

  (<any>PropertyModel).prototype.addComponent = PropertyModel.prototype.addComponents;
  (<any>PropertyModel).prototype.removeComponent = PropertyModel.prototype.removeComponents;

}