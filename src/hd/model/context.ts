/*####################################################################
 * Classes/interfaces related to components.
 */
module hd.model {

  import u = hd.utility;
  import r = hd.reactive;

  /*******************************************************************
     Helpers
   ******************************************************************/

  // getter for constant
  function pathConstant( p: Path ) {
    return p.isConstant();
  }

  // object that can retrieve a path for a string
  interface PathLookup {
    get( name: string ): Path;
  }

  // ojbect that has an id
  interface HasId {
    id: string;
  }

  // lexicographical comparison for array
  function compareAnys( a: any[], b: any[] ) {
    for (var i = 0, l = a.length, m = b.length; i < l && i < m; ++i) {
      if (a[i] !== b[i]) {
        var ai = a[i];
        var bi = b[i];
        var cmp: number;
        if ((ai instanceof Variable || ai instanceof Constraint || ai instanceof Command) &&
            (bi instanceof Variable || bi instanceof Constraint || bi instanceof Command)   ) {
          cmp = ai.id.localeCompare( bi.id );
        }
        else if (Array.isArray( ai ) && Array.isArray( bi )) {
          cmp = compareAnys( ai, bi );
        }
        else if (typeof ai === 'number' && typeof bi === 'number') {
          cmp = ai - bi;
        }
        else if (typeof ai === 'string' && typeof bi === 'string') {
          cmp = ai.localeCompare( bi );
        }
        else {
          cmp = (ai + "").localeCompare( bi + "" );
        }
        if (cmp != 0) {
          return cmp;
        }
      }
    }

    return l - m;
  }

  // find the differences between two SORTED arrays
  function listDiff<T>( a: T[], b: T[], compare: (a: T, b: T) => number ) {
    var leftOnly    = <T[]> [];
    var leftShared  = <T[]> [];
    var rightOnly   = <T[]> [];
    var rightShared = <T[]> []

    var i = 0;
    var j = 0;
    var l = a.length;
    var  m = b.length;
    while (i < l && j < m) {
      var cmp = compare( a[i], b[j] );
      if (cmp < 0) {
        leftOnly.push( a[i] );
        ++i;
      }
      else if (cmp > 0) {
        rightOnly.push( b[j] );
        ++j;
      }
      else {
        leftShared.push( a[i] );
        rightShared.push( b[j] );
        ++i; ++j;
      }
    }

    while (i < l) {
      leftOnly.push( a[i] );
      ++i;
    }

    while (j < m) {
      rightOnly.push( b[j] );
      ++j;
    }

    return {leftOnly: leftOnly, leftShared: leftShared,
            rightOnly: rightOnly, rightShared: rightShared};
  }

  function addToList( list: any[], value: any, interpolations: number ) {
    if (interpolations == 0) {
      list.push( value );
    }
    else if (interpolations == 1) {
      list.push.apply( list, value );
    }
    else {
      for (var i = 0, l = value.length; i < l; ++i) {
        addToList( list, value[i], interpolations - 1 );
      }
    }
  }

  /*******************************************************************
    Component elements
   ******************************************************************/

  // Union type for all possible elements
  export
  type ComponentElement = Variable | Component | Constraint | Command | TouchDep | Output;

  // Wrapper class to represent touch dependency
  export
  class TouchDep {
    constructor( public from: Variable | Constraint, public to: Variable | Constraint ) { }
  }

  // Wrapper class to represent output
  export
  class Output {
    constructor( public variable: Variable ) { }
  }

  export
  interface ComponentClass {
    new (): Component;
  }

  // Changes made by a component in response to an update
  export
  interface ComponentChanges {
    removes: ComponentElement[];
    adds: ComponentElement[]
  }

  /*******************************************************************
    Specs -- specify an element of a constraint class
   ******************************************************************/

  export
  interface ConstantSpec {
    loc: string;
    value: any;
  }

  export
  interface VariableSpec {
    loc: string;
    init: any;
    optional: Optional;
    eq?: u.EqualityPredicate<any>;
  }

  export
  interface NestedSpec {
    loc: string;
    cmpType?: ComponentClass|ComponentSpec;
  }

  export
  interface ReferenceSpec {
    loc: string;
    eq?: u.EqualityPredicate<any>;
  }

  export
  interface MethodSpec {
    inputs: u.MultiArray<string>;
    priorFlags: u.MultiArray<boolean>;
    outputs: u.MultiArray<string>;
    fn: Function;
  }

  export
  interface ConstraintSpec {
    loc?: string;
    variables: u.ArraySet<string>;
    methods: u.ArraySet<MethodSpec>;
    optional: Optional;
    touchVariables?: u.ArraySet<string>;
  }

  export
  interface CommandSpec {
    loc: string;
    inputs: u.MultiArray<string>;
    priorFlags: u.MultiArray<boolean>;
    outputs: u.MultiArray<string>;
    fn: Function;
    synchronous: boolean;
  }

  export
  interface TouchDepSpec {
    from: string;
    to: string;
  }

  export
  interface OutputSpec {
    variable: string;
  }

  export
  interface ComponentSpec {
    constants: ConstantSpec[];
    variables: VariableSpec[];
    nesteds: NestedSpec[];
    references: ReferenceSpec[];
    constraints: ConstraintSpec[];
    commands: CommandSpec[];
    touchDeps: TouchDepSpec[];
    outputs: OutputSpec[];
  }

  /*******************************************************************
    Templates -- represent an element that changes as paths change.

    Instances -- represent a single filling of blanks in a template.
   ******************************************************************/

  // Union type for instances
  type TemplateInstance = ConstraintInstance | CommandInstance | TouchDepInstance | OutputInstance;

  // getter for element associated with instance
  function getElement( inst: TemplateInstance ) {
    return inst.element;
  }

  /*==================================================================
   * Abstract base class for all templates.
   * For generality, this class does not interact directly with paths.
   * That means its the derived class' responsibility to:
   * - in constructor, subscribe to any paths used by the template
   * - in constructor, pick a path and assign to master
   * - in destructor, unsubscribe to all paths
   */
  class Template extends r.BasicObservable<Template> {
    name: string;

    // All paths used by this template
    paths: u.ArraySet<Path> = [];

    // All instances created from this template, in sorted order
    instances : TemplateInstance[] = [];

    // Have their been any changes since the last update?
    changed = true;

    /*----------------------------------------------------------------
     */
    addPath( path: Path ) {
      if (u.arraySet.add( this.paths, path )) {
        path.addObserver( this );
      }
    }

    addPaths( paths: Path[] ) {
      paths.forEach( this.addPath, this );
    }

    /*----------------------------------------------------------------
     */
    isConstant(): boolean {
      return this.paths.every( pathConstant );
    }

    /*----------------------------------------------------------------
     * To be implemented by derived classes
     */

    // Abstract:  Create an instance for a given position
    define( pos: Position ): TemplateInstance {
      throw "Attempt to call abstract method";
    }

    // Abstract:  Order two instances
    compare( a: TemplateInstance, b: TemplateInstance ): number {
      throw "Attempt to call abstract method";
    }

    // Abstract:  Create element for instance
    create( inst: TemplateInstance ) {
      throw "Attempt to call abstract method";
    }

    /*----------------------------------------------------------------
     * Overload addObserver so that subscribing to a template needing
     * updates results in automatic notification.
     */
    addObserver( observer: r.Observer<Template> ): r.Observer<Template>;
    addObserver( object: Object,
                 onNext: (value: Template) => void,
                 onError: (error: any) => void,
                 onCompleted: () => void        ): r.Observer<Template>;
    addObserver<U>( object: Object,
                    onNext: (value: Template, id?: U) => void,
                    onError: (error: any, id?: U) => void,
                    onCompleted: (id?: U) => void,
                    id: U                                  ): r.Observer<Template>;
    addObserver( object: Object,
                 onNext?: (value: Template, id?: any) => void,
                 onError?: (error: any, id?: any) => void,
                 onCompleted?: (id?: any) => void,
                 id?: any                                  ): r.Observer<Template> {
      var added: r.Observer<Template>;
      if (arguments.length == 1) {
        added = super.addObserver( <r.Observer<Template>>object );
      }
      else {
        added = super.addObserver( object, onNext, onError, onCompleted, id );
      }
      if (added && this.changed) {
        added.onNext( this );
      }
      return added;
    }

    /*----------------------------------------------------------------
     * Recalculate all instances and report any changes.
     */
    update( changes: ComponentChanges ) {
      var newInstances = <TemplateInstance[]> [];

      if (this.paths.length > 0) {
        for (var itr = new PathSetIterator( <Path[]>this.paths );
             itr.pos !== null;
             itr.next()) {
          var inst = this.define( itr.pos );
          if (inst) {
            newInstances.push( inst );
          }
        }
      }
      else {
        var inst = this.define( {} );
        if (inst) {
          newInstances.push( inst );
        }
      }

      // Sort the list
      newInstances.sort( this.compare );

      // Calculate difference between this list and our new list
      var diff = listDiff( this.instances, newInstances, this.compare );

      // Put leftOnly on the remove list
      if (diff.leftOnly.length > 0) {
        changes.removes.push.apply( changes.removes, diff.leftOnly.map( getElement ) );
      }

      // Copy over elements for shared
      for (var i = 0, l = diff.leftShared.length; i < l; ++i) {
        diff.rightShared[i].element = diff.leftShared[i].element;
      }

      // Create elements for rightOnly and put on the add list
      if (diff.rightOnly.length > 0) {
        diff.rightOnly.forEach( function( inst: TemplateInstance ) {
          this.create( inst );
          changes.adds.push( inst.element );
        }, this );
      }

      // Record results
      this.instances = newInstances;
      this.changed = false;
    }

    /*----------------------------------------------------------------
     * All current elements created by this template
     */
    getElements(): ComponentElement[] {
      return this.instances.map( getElement );
    }

    /*----------------------------------------------------------------
     * When a path used by this template changes.  Currently, we
     * ignore the position that changes and just always recalculate
     * all positions.
     */
    onNext() {
      if (! this.changed) {
        this.changed = true;
        this.sendNext( this );
      }
    }

    onError() { }

    onCompleted() { }

    /*----------------------------------------------------------------
     */
    destruct() {
      for (var i = 0, l = this.paths.length; i < l; ++i) {
        this.paths[i].removeObserver( this );
      }
    }
  }

  /*==================================================================
   * MethodTemplate slightly different from other templates.
   * It's not actually a template in its own right (doesn't inherit
   * from Template class); it's more a helper for ConstraintTemplate
   */
  interface MethodInstance {
    inputs: u.MultiArray<any>;
    outputs: u.MultiArray<Variable>;
  }

  class MethodTemplate {
    name: string;
    inputs: u.MultiArray<Path>;
    priorFlags: u.MultiArray<boolean>;
    outputs: u.MultiArray<Path>;
    fn: Function;

    /*----------------------------------------------------------------
     * Look up paths, but don't subscribe; the constraint template
     * handles that
     */
    constructor( mspec: MethodSpec, lookup: PathLookup ) {
      this.inputs = u.multiArray.map( mspec.inputs, lookup.get, lookup );
      if (mspec.priorFlags) {
        this.priorFlags = u.multiArray.copy( mspec.priorFlags );
      }
      this.outputs = u.multiArray.map( mspec.outputs, lookup.get, lookup );
      this.fn = mspec.fn;
      this.name = u.multiArray.toString( mspec.inputs ) + '->' +
            u.multiArray.toString( mspec.outputs );
    }

    /*----------------------------------------------------------------
     * Create an instance for a given position
     */
    define( pos: Position ): MethodInstance {
      var get = function( p: Path ) { return p.get( pos ) };
      var ins = u.multiArray.map( this.inputs, get );
      var outs = u.multiArray.map( this.outputs, get );

      // Check outputs:  all variables, no duplicates
      var outVars = u.multiArray.flatten( outs );
      for (var i = 0, l = outVars.length; i < l; ++i) {
        if (outVars[i] === undefined) {
          return null;
        }
        if (! (outVars[i] instanceof Variable)) {
          console.warn( 'Method cannot be instantiated with non-variable output: ' + this.name );
          return null;
        }
        for (var j = i + 1; j < l; ++j) {
          if (outVars[i] === outVars[j]) {
            console.warn( 'Method cannot be instantiated with duplicate output: ' + this.name );
            return null;
          }
        }
      }

      // Recursively check inputs:  current-value variable cannot be output
      var checkInputs = function( ins: u.MultiArray<any>, priors: u.MultiArray<boolean> ) {
        for (var i = 0, l = ins.length; i < l; ++i) {
          if (ins[i] === undefined) {
            return false;
          }
          else if (Array.isArray( ins[i] )) {
            if (! checkInputs( ins[i], priors ? <u.MultiArray<boolean>>priors[i] : undefined )) {
              return false;
            }
          }
          else if (ins[i] instanceof Variable &&
              !(priors && priors[i]) &&
              outVars.indexOf( ins[i] ) >= 0) {
            console.warn( 'Method cannot be instantiated with same variable as input and output: ' +
                          this.name );
            return false;
          }
        }
        return true;
      };

      if (! checkInputs( ins, this.priorFlags )) {
        return null;
      }

      return {inputs: ins, outputs: outs};
    }

    /*----------------------------------------------------------------
     * Create element for instance; requires list of other variables
     * in the constraint.
     */
    create( inst: MethodInstance, vars: u.ArraySet<Variable> ): Method {
      var outVars = u.multiArray.flatten( inst.outputs );
      return new Method( this.name,
                         this.fn,
                         inst.inputs,
                         this.priorFlags,
                         inst.outputs,
                         u.arraySet.difference( vars, outVars ),
                         outVars
                       );
    }
  }

  /*==================================================================
   * Constraint Template.
   */
  class ConstraintInstance {
    element: Constraint;

    constructor( public all: any[],
                 public variables: Variable[],
                 public methods: MethodInstance[],
                 public touchVariables: Variable[],
                 public pos: Position ) { }
  }

  class ConstraintTemplate extends Template {
    variables: Path[];
    methods: MethodTemplate[];
    optional: Optional;
    touchVariables: Path[];

    /*----------------------------------------------------------------
     * Initialize, look up paths, subscribe
     */
    constructor( spec: ConstraintSpec, lookup: PathLookup ) {
      super();
      this.addPaths( this.variables = spec.variables.map( lookup.get, lookup ) );
      this.methods = spec.methods.map( function( mspec: MethodSpec ) {
        return new MethodTemplate( mspec, lookup );
      } );
      this.optional = spec.optional;
      if (spec.touchVariables && spec.touchVariables.length) {
        this.addPaths( this.touchVariables = spec.touchVariables.map( lookup.get, lookup ) );
      }
      this.name = spec.variables.join( ',' )
    }

    /*----------------------------------------------------------------
     * Create an instance for a given position.
     */
    define( pos: Position ) {
      var all = <any[]> [];

      for (var i = 0, l = this.variables.length; i < l; ++i) {
        var vv = this.variables[i].get( pos );
        if (vv === undefined) {
          return null;
        }
        addToList( all, vv, this.variables[i].slices );
      }

      var vvs = <Variable[]>all.filter( u.isType( Variable ) );

      var minsts = <MethodInstance[]> [];
      var hasMethods = false;

      for (var i = 0, l = this.methods.length; i < l; ++i) {
        var minst = this.methods[i].define( pos );
        if (minst) {
          minsts[i] = minst;
          hasMethods = true;
        }
      }

      if (hasMethods) {
        var tvs : u.ArraySet<Variable>;
        if (this.touchVariables && this.touchVariables.length) {
          tvs = [];
          for (var i = 0, l = this.touchVariables.length; i < l; ++i) {
            var vv = this.touchVariables[i].get( pos );
            if (vv instanceof Variable) {
              u.arraySet.add( tvs, vv );
            }
          }
        }

        return new ConstraintInstance( all, vvs, minsts, <Variable[]>tvs, pos );
      }
      else {
        return null;
      }
    }

    /*----------------------------------------------------------------
     * Order two instances
     */
    compare( a: ConstraintInstance, b: ConstraintInstance ) {
      var cmp = compareAnys( a.all, b.all );
      if (cmp == 0 && a.touchVariables) {
        cmp = compareAnys( a.touchVariables, b.touchVariables );
      }
      return cmp;
    }

    /*----------------------------------------------------------------
     * Create element for instance
     */
    create( inst: ConstraintInstance ) {
      var name = this.name.replace( /\[(\d*)([a-zA-Z][\w$]*)/g,
                                    function( all, n, v ) {
                                      return '[' + n + inst.pos[v];
                                    } );
      var cc = new Constraint( name, inst.variables, inst.touchVariables );
      cc.optional = this.optional;
      for (var i = 0, l = inst.methods.length; i < l; ++i) {
        if (inst.methods[i]) {
          cc.addMethod(
            this.methods[i].create( inst.methods[i], inst.variables )
          );
        }
      }
      inst.element = cc;
    }
  }

  /*==================================================================
   * Command Template.
   */
  class CommandInstance {
    element: Command;

    constructor( public inputs: u.MultiArray<any>,
                 public outputs: u.MultiArray<Variable> ) { }
  }

  class CommandTemplate extends Template {
    inputs: u.MultiArray<Path>;
    priorFlags: u.MultiArray<boolean>;
    outputs: u.MultiArray<Path>;
    fn: Function;
    synchronous: boolean;

    /*----------------------------------------------------------------
     * Initialize, look up paths, subscribe
     */
    constructor( cmdspec: CommandSpec, lookup: PathLookup ) {
      super();

      this.inputs = u.multiArray.map( cmdspec.inputs, lookup.get, lookup )
      var inputPaths = u.multiArray.flatten( this.inputs );
      this.addPaths( inputPaths )

      if (cmdspec.priorFlags) {
        this.priorFlags = u.multiArray.copy( cmdspec.priorFlags );
      }
      this.outputs = u.multiArray.map( cmdspec.outputs, lookup.get, lookup )
      var outputPaths = u.multiArray.flatten( this.outputs );
      this.addPaths( outputPaths )

      this.fn = cmdspec.fn;
      this.synchronous = cmdspec.synchronous;
      this.name = u.multiArray.toString( cmdspec.inputs ) + '->' +
            u.multiArray.toString( cmdspec.outputs );
      this.activate = this.activate.bind( this );
    }

    /*----------------------------------------------------------------
     * Create an instance for a given position.
     */
    define( pos: Position ) {
      var get = function( p: Path ) { return p.get( pos ) };
      var ins = u.multiArray.map( this.inputs, get );
      var outs = u.multiArray.map( this.outputs, get );

      // Check outputs:  all variables, no duplicates
      var outVars = u.multiArray.flatten( outs );
      for (var i = 0, l = outVars.length; i < l; ++i) {
        if (outVars[i] === undefined) {
          return null;
        }
        if (! (outVars[i] instanceof Variable)) {
          console.warn( 'Command cannot be instantiated with non-variable output: ' + this.name );
          return null;
        }
        for (var j = i + 1; j < l; ++j) {
          if (outVars[i] === outVars[j]) {
            console.warn( 'Command cannot be instantiated with duplicate output: ' + this.name );
            return null;
          }
        }
      }

      // Recursively check inputs:  current-value variable cannot be output
      var checkInputs = function( ins: u.MultiArray<any>, priors: u.MultiArray<boolean> ) {
        for (var i = 0, l = ins.length; i < l; ++i) {
          if (ins[i] === undefined) {
            return false;
          }
          else if (Array.isArray( ins[i] )) {
            if (! checkInputs( ins[i], priors ? <u.MultiArray<boolean>>priors[i] : undefined )) {
              return false;
            }
          }
          else if (ins[i] instanceof Variable &&
              !(priors && priors[i]) &&
              outVars.indexOf( ins[i] ) >= 0) {
            console.warn( 'Command cannot be instantiated with same variable as input and output: ' +
                          this.name );
            return false;
          }
        }
        return true;
      };

      if (! checkInputs( ins, this.priorFlags )) {
        return null;
      }

      return new CommandInstance( ins, outs );
    }

    /*----------------------------------------------------------------
     * Order two instances
     */
    compare( a: CommandInstance, b: CommandInstance ) {
      var cmp = compareAnys( a.inputs, b.inputs );
      if (cmp == 0) {
        cmp = compareAnys( a.outputs, b.outputs );
      }
      return cmp;
    }

    /*----------------------------------------------------------------
     * Create element for instance
     */
    create( inst: CommandInstance ) {
      if (this.synchronous) {
        inst.element = new SynchronousCommand( this.name,
                                               this.fn,
                                               inst.inputs,
                                               this.priorFlags,
                                               inst.outputs     );
      }
      else {
        inst.element = new Command( this.name,
                                    this.fn,
                                    inst.inputs,
                                    this.priorFlags,
                                    inst.outputs     );
      }
    }

    /*----------------------------------------------------------------
     */
    activate() {
      var cmds = this.getElements();
      if (cmds.length) {
        (<Command>cmds[0]).activate();
      }
    }
  }

  /*==================================================================
   * TouchDep Template.
   */
  class TouchDepInstance {
    element: TouchDep;

    constructor( public from: Constraint|Variable,
                 public to: Constraint|Variable    ) { }
  }

  class TouchDepTemplate extends Template {
    from: Path;
    to: Path;

    /*----------------------------------------------------------------
     * Initialize, look up paths, subscribe
     */
    constructor( spec: TouchDepSpec, lookup: PathLookup ) {
      super();
      this.addPath( this.from = lookup.get( spec.from ) );
      this.addPath( this.to = lookup.get( spec.to ) );
      this.name = this.from + '=>' + this.to;
    }

    /*----------------------------------------------------------------
     * Create an instance for a given position.
     */
    define( pos: Position ) {
      var cc1 = this.from.get( pos );
      var cc2 = this.to.get( pos );
      if (cc1 !== cc2 &&
          (cc1 instanceof Variable || cc1 instanceof Constraint) &&
          (cc2 instanceof Variable || cc2 instanceof Constraint)   ) {
        return new TouchDepInstance( cc1, cc2 );
      }
      else {
        return null;
      }
    }

    /*----------------------------------------------------------------
     * Order two instances
     */
    compare( a: TouchDepInstance, b: TouchDepInstance ) {
      var cmp = a.from.id.localeCompare( b.from.id );
      if (cmp == 0) {
        cmp = a.to.id.localeCompare( b.to.id );
      }
      return cmp;
    }

    /*----------------------------------------------------------------
     * Create element for instance
     */
    create( inst: TouchDepInstance ) {
      inst.element = new TouchDep( inst.from, inst.to );
    }
  }

  /*==================================================================
   * Output Template;
   */
  class OutputInstance {
    element: Output;

    constructor( public variable: Variable ) { }
  }

  class OutputTemplate extends Template {
    variable: Path;

    /*----------------------------------------------------------------
     * Initialize, look up paths, subscribe
     */
    constructor( spec: OutputSpec, lookup: PathLookup ) {
      super();
      this.addPath( this.variable = lookup.get( spec.variable ) );
      this.name = '@' + spec.variable;
    }

    /*----------------------------------------------------------------
     * Create an instance for a given position.
     */
    define( pos: Position ) {
      var vv = this.variable.get( pos );
      if (vv instanceof Variable) {
        return new OutputInstance( vv );
      }
    }

    /*----------------------------------------------------------------
     * Order two instances
     */
    compare( a: OutputInstance, b: OutputInstance ) {
      return a.variable.id.localeCompare( b.variable.id );
    }

    /*----------------------------------------------------------------
     * Create element for instance
     */
    create( inst: OutputInstance ) {
      inst.element = new Output( inst.variable );
    }
  }


  /*******************************************************************
    The Component type
   ******************************************************************/

  /*==================================================================
   * The actual data members of a component are held in a separate
   * class.  If a dynamic element does not use any references then
   * it is simply instantiated and stored; if it does, then we store
   * a template for the element.
   */
  class ComponentData extends r.BasicObservable<Component> {

    // The component object this belongs to
    component: Component;

    // The static elements
    elements: u.ArraySet<ComponentElement> = [];

    // Templates for dynamic elements
    templates: Template[] = [];

    // Any static elements added since the last update
    added: ComponentElement[] = [];

    // Any static elements removed since the last update
    removed: ComponentElement[] = [];

    // Templates whose paths have changed since last update
    outdated: Template[] = [];

    // Have any changes been made since last update?
    changed = false;

    // All paths used by this component (to promote sharing among templates)
    paths: u.Dictionary<any> = {};

    // Init
    constructor( cmp: Component ) {
      super();
      this.component = cmp;
    }

    /*----------------------------------------------------------------
     * Ensure this sends only a single changed message between
     * updates.
     */
    reportChanged() {
      if (! this.changed) {
        this.changed = true;
        this.sendNext( this.component );
      }
    }

    /*----------------------------------------------------------------
     * Return all elements currently in the component.
     */
    getElements() {
      return (<ComponentElement[]>this.elements).concat(
        u.concatmap( this.templates, function( tmpl: Template ) {
          return tmpl.getElements()
        } )
      );
    }

    /*----------------------------------------------------------------
     * Adds a static element to the component
     */
    addStatic( element: ComponentElement ): boolean {
      var added = false;
      if (u.arraySet.remove( this.removed, element )) {
        added = true;
      }

      if (! u.arraySet.contains( this.elements, element ) &&
          u.arraySet.add( this.added, element )             ) {
        added = true;
        this.reportChanged();
      }

      return added;
    }

    /*----------------------------------------------------------------
     * Removes a static element to the component
     */
    removeStatic( element: ComponentElement ): boolean {
      var removed = false;
      if (u.arraySet.remove( this.added, element )) {
        removed = true;
      }

      if (u.arraySet.contains( this.elements, element ) &&
          u.arraySet.add( this.removed, element )         ) {
        removed = true;
        this.reportChanged();
      }

      return removed;
    }

    /*----------------------------------------------------------------
     * Adds a template to the component
     */
    addTemplate( tmpl: Template ) {
      if (tmpl.isConstant()) {
        var changes: ComponentChanges = {removes: [], adds: []};
        tmpl.update( changes );
        if (changes.adds.length > 0) {
          changes.adds.forEach( this.addStatic, this );
        }
        else {
          console.warn( "Could not instantiate constant template: " + tmpl.name );
        }
      }
      else {
        if (u.arraySet.add( this.templates, tmpl )) {
          tmpl.addObserver( this );
        }
      }
    }

    /*----------------------------------------------------------------
     */
    update(): ComponentChanges {
      var removed = this.removed;
      this.removed = [];
      if (removed.length > 0) {
        this.elements = u.arraySet.difference( this.elements, removed );
      }

      var added = this.added;
      this.added = [];
      if (added.length > 0) {
        Array.prototype.push.apply( this.elements, added );
      }

      var result = {adds: added, removes: removed};
      if (this.outdated.length > 0) {
        for (var i = 0, l = this.outdated.length; i < l; ++i) {
          this.outdated[i].update( result );
        }
        this.outdated = [];
      }

      this.changed = false;
      return result;
    }

    /*----------------------------------------------------------------
     * Implement Observable<Template>
     */
    onNext( tmpl: Template ) {
      this.outdated.push( tmpl );
      this.reportChanged();
    }
    onError() { }
    onCompleted() { }

    /*----------------------------------------------------------------
     * Implement PathLookup
     */
    get( name: string ) {
      var path = this.paths[name];
      if (! path) {
        path = this.paths[name] = new Path( this.component, name );
      }
      return path;
    }

    /*----------------------------------------------------------------
     * Overload addObserver so that subscribing to a component needing
     * updates results in automatic notification.
     */
    addObserver( observer: r.Observer<Component> ): r.Observer<Component>;
    addObserver( object: Object,
                 onNext: (value: Component) => void,
                 onError: (error: any) => void,
                 onCompleted: () => void        ): r.Observer<Component>;
    addObserver<U>( object: Object,
                    onNext: (value: Component, id?: U) => void,
                    onError: (error: any, id?: U) => void,
                    onCompleted: (id?: U) => void,
                    id: U                                  ): r.Observer<Component>;
    addObserver( object: Object,
                 onNext?: (value: Component, id?: any) => void,
                 onError?: (error: any, id?: any) => void,
                 onCompleted?: (id?: any) => void,
                 id?: any                                  ): r.Observer<Component> {
      var added: r.Observer<Component>;
      if (arguments.length == 1) {
        added = super.addObserver( <r.Observer<Component>>object );
      }
      else {
        added = super.addObserver( object, onNext, onError, onCompleted, id );
      }
      if (added && this.changed) {
        added.onNext( this.component );
      }
      return added;
    }
  }

  /*==================================================================
   * The component class itself has a hidden ComponentData field; all
   *   other fields are user-defined component properties.
   * (Member functions of the component class are all static.)
   */
  export
  class Component {

    private '#hd_data': ComponentData;

    [key: string]: any;

    /*----------------------------------------------------------------
     * Copies any fields found in init
     */
    constructor( spec?: ComponentSpec, init?: u.Dictionary<any> ) {
      if (spec) {
        Component.construct( this, spec, init );
      }
    }

    /*----------------------------------------------------------------
     * A "constructor" - add everything from component spec to the
     * given component.
     */
    static
    construct(
      cmp: Component,
      spec: ComponentSpec,
      init?: u.Dictionary<any>
    ): Component {
      if (! (cmp instanceof Component)) {
        throw "Attempting to construct component using specification failed:  object not a component!";
      }
      if (init) {
        if (typeof init !== 'object') {
          throw "Invalid initialization object passed to Component.construct: " + init;
        }
      }
      else {
        init = {};
      }

      for (var i = 0, l = spec.constants.length; i < l; ++i) {
        var tspec = spec.constants[i];
        if (! (tspec.loc in cmp)) {
          Component.addConstant( cmp, spec.constants[i] );
        }
      }

      var variables = spec.variables.filter( function( vspec: VariableSpec ) {
        return ! (vspec.loc in cmp);
      } );

      // Initialized/min
      for (var i = variables.length - 1; i >= 0; --i) {
        var vspec = variables[i];
        if ((vspec.optional === Optional.Min &&
             (vspec.init !== undefined || init[vspec.loc] !== undefined)) ||
            (vspec.optional === Optional.Default &&
             init[vspec.loc] === undefined &&
             vspec.init !== undefined)) {
          Component.addVariable( cmp, vspec, init[vspec.loc] );
        }
      }

      // Uninitialized/min
      for (var i = variables.length - 1; i >= 0; --i) {
        var vspec = variables[i];
        if ((vspec.optional === Optional.Default || vspec.optional === Optional.Min) &&
            vspec.init === undefined &&
            init[vspec.loc] === undefined) {
          Component.addVariable( cmp, vspec, init[vspec.loc] );
        }
      }

      // Uninitialized/max
      for (var i = 0, l = variables.length; i < l; ++i) {
        var vspec = variables[i];
        if (vspec.optional === Optional.Max &&
            vspec.init === undefined &&
            init[vspec.loc] === undefined) {
          Component.addVariable( cmp, vspec, init[vspec.loc] );
        }
      }

      // Initialized/max
      for (var i = 0, l = variables.length; i < l; ++i) {
        var vspec = variables[i];
        if ((vspec.optional === Optional.Max &&
             (vspec.init !== undefined || init[vspec.loc] !== undefined)) ||
            (vspec.optional === Optional.Default &&
             init[vspec.loc] !== undefined)) {
          Component.addVariable( cmp, vspec, init[vspec.loc] );
        }
      }

      for (var i = 0, l = spec.nesteds.length; i < l; ++i) {
        var nspec = spec.nesteds[i];
        if (! (nspec.loc in cmp)) {
          Component.addNestedComponent( cmp, nspec, init[nspec.loc] );
        }
      }

      for (var i = 0, l = spec.references.length; i < l; ++i) {
        var rspec = spec.references[i];
        if (! (rspec.loc in cmp)) {
          Component.addReference( cmp, rspec, init[rspec.loc] );
        }
      }

      for (var i = 0, l = spec.constraints.length; i < l; ++i) {
        Component.addConstraint( cmp, spec.constraints[i] );
      }

      for (var i = 0, l = spec.commands.length; i < l; ++i) {
        Component.addCommand( cmp, spec.commands[i] );
      }

      for (var i = 0, l = spec.touchDeps.length; i < l; ++i) {
        Component.addTouchDep( cmp, spec.touchDeps[i] );
      }

      for (var i = 0, l = spec.outputs.length; i < l; ++i) {
        Component.addOutput( cmp, spec.outputs[i] );
      }

      return cmp;
    }

    /*----------------------------------------------------------------
     */
    static
    addConstant( cmp: Component, spec: ConstantSpec ) {
      cmp[spec.loc] = spec.value;
    }

    /*----------------------------------------------------------------
     * Add variable
     */
    static
    addVariable( cmp: Component, spec: VariableSpec, init: any ) {
      var hd_data = cmp['#hd_data'];
      var vv = new Variable( spec.loc, init === undefined ? spec.init : init, spec.eq );
      if (spec.optional !== Optional.Default) {
        vv.optional = spec.optional;
      }
      else {
        vv.optional = (init === undefined ? Optional.Min : Optional.Max);
      }
      hd_data.addStatic( vv );
      cmp[spec.loc] = vv;
    }

    /*----------------------------------------------------------------
     * Add nested component
     */
    static
    addNestedComponent( cmp: Component, spec: NestedSpec, init: u.Dictionary<any> ) {
      var hd_data = cmp['#hd_data'];
      var nested: Component;
      if (typeof spec.cmpType === 'function') {
        nested = new (<ComponentClass>spec.cmpType)();
      }
      else {
        nested = new Component();
        if (spec.cmpType) {
          Component.construct( nested, <ComponentSpec>spec.cmpType );
        }
      }
      hd_data.addStatic( nested );
      cmp[spec.loc] = nested;
    }

    /*----------------------------------------------------------------
     * Add dynamic reference
     */
    static
    addReference( cmp: Component, spec: ReferenceSpec, init: any ) {
      var prop = new r.BasicSignal<any>( init, spec.eq );
      Component.defineReferenceAccessors( cmp, spec.loc, prop );
    }

    static
    defineReferenceAccessors( cmp: Component, loc: string, prop: r.BasicSignal<any> ) {
      Object.defineProperty( cmp, '$'+loc, {configurable: true,
                                            enumerable: false,
                                            value: prop
                                           }
                           );
      Object.defineProperty( cmp, loc, {configurable: true,
                                        enumerable: true,
                                        get: prop.get.bind( prop ),
                                        set: prop.set.bind( prop )
                                       }
                           );
    }

    /*----------------------------------------------------------------
     * Add constraint
     */
    static
    addConstraint( cmp: Component, spec: ConstraintSpec ) {
      var hd_data = cmp['#hd_data'];

      var tmpl = new ConstraintTemplate( spec, hd_data );
      hd_data.addTemplate( tmpl );

      if (spec.loc) {
        cmp[spec.loc] = tmpl;
      }
    }

    /*----------------------------------------------------------------
     * Add command
     */
    static
    addCommand( cmp: Component, spec: CommandSpec ) {
      var hd_data = cmp['#hd_data'];

      var tmpl = new CommandTemplate( spec, hd_data );
      hd_data.addTemplate( tmpl );

      if (spec.loc && tmpl.isConstant()) {
        cmp[spec.loc] = tmpl.instances[0].element;
      }
    }

    /*----------------------------------------------------------------
     * Add touch dependency
     */
    static
    addTouchDep( cmp: Component, spec: TouchDepSpec ) {
      var hd_data = cmp['#hd_data'];

      hd_data.addTemplate( new TouchDepTemplate( spec, hd_data ) );
    }

    /*----------------------------------------------------------------
     * Add output
     */
    static
    addOutput( cmp: Component, spec: OutputSpec ) {
      var hd_data = cmp['#hd_data'];

      hd_data.addTemplate( new OutputTemplate( spec, hd_data ) );
    }

    /*----------------------------------------------------------------
     * Update all templates which need it, but also record the changes
     *   which were made.
     */
    static
    update( cmp: Component ): ComponentChanges {
      var hd_data = cmp['#hd_data'];

      return hd_data.update();
    }

    /*----------------------------------------------------------------
     * Getter
     */
    static
    changes( cmp: Component ): r.ProxyObservable<Component> {
      return cmp['#hd_data'];
    }

    /*----------------------------------------------------------------
     * Getter
     */
    static
    elements( cmp: Component ): ComponentElement[] {
      var hd_data = cmp['#hd_data'];

      return hd_data.getElements();
    }

    /*----------------------------------------------------------------
     */
    static
    claim( cmp: Component, el: Component|Variable ): boolean {
      var hd_data = cmp['#hd_data'];

      return hd_data.addStatic( el );
    }

    /*----------------------------------------------------------------
     */
    static
    release( cmp: Component, el: Component|Variable ): boolean {
      var hd_data = cmp['#hd_data'];

      return hd_data.removeStatic( el );
    }

    /*----------------------------------------------------------------
     */
    static
    destruct( cmp: Component ) {
      var hd_data = cmp['#hd_data'];

      for (var i = 0, l = hd_data.templates.length; i < l; ++i) {
        hd_data.templates[i].destruct();
      }
    }
  }

  /*------------------------------------------------------------------
   * Rather than require every component subclass to call the component
   * constructor, we define a getter that creates it the first time it
   * is accessed.
   */
  Object.defineProperty( Component.prototype, '#hd_data', {
    get: function makeData() {
      var data = new ComponentData( this );
      Object.defineProperty( this, '#hd_data', {configurable: true,
                                                enumerable: false,
                                                value: data
                                               }
                           );
      return data;
    }
  } );

}
